// Based on https://github.com/pulumi/examples/tree/master/kubernetes-ts-guestbook/simple
// with exporters and a ServiceMonitor added for Prometheus.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export interface GuestbookArgs {
    namespace: string;
    frontendReplicas: number;
    frontendNodePort: number;
    redisExporterImage: string;
    apacheExporterImage: string;
    trafficGenerator: boolean;
    loadBalancerReady: pulumi.Resource[];  // metallb pool
    prometheusReady: pulumi.Resource[];    // ServiceMonitor CRD comes from the helm chart
}

const METRICS_LABEL = { "monitoring.guestbook/scrape": "true" };

export class Guestbook extends pulumi.ComponentResource {
    public readonly frontendService: k8s.core.v1.Service;
    public readonly namespace: pulumi.Output<string>;

    constructor(name: string, args: GuestbookArgs, opts?: pulumi.ComponentResourceOptions) {
        super("guestbook:app:Guestbook", name, {}, opts);
        const parent = { parent: this };

        const ns = new k8s.core.v1.Namespace(name, { metadata: { name: args.namespace } }, parent);
        this.namespace = ns.metadata.name;
        const namespace = ns.metadata.name;

        // redis_exporter sidecar on 9121
        const redisExporter = (): k8s.types.input.core.v1.Container => ({
            name: "redis-exporter",
            image: args.redisExporterImage,
            env: [{ name: "REDIS_ADDR", value: "redis://localhost:6379" }],
            ports: [{ name: "metrics", containerPort: 9121 }],
            resources: { requests: { cpu: "10m", memory: "16Mi" }, limits: { memory: "64Mi" } },
        });

        // redis leader
        const redisLeaderLabels = { app: "redis-leader", tier: "backend" };
        const redisLeaderDeployment = new k8s.apps.v1.Deployment("redis-leader", {
            metadata: { name: "redis-leader", namespace },
            spec: {
                selector: { matchLabels: redisLeaderLabels },
                template: {
                    metadata: { labels: redisLeaderLabels },
                    spec: {
                        containers: [
                            {
                                name: "redis-leader",
                                image: "redis",
                                resources: { requests: { cpu: "100m", memory: "100Mi" } },
                                ports: [{ containerPort: 6379 }],
                            },
                            redisExporter(),
                        ],
                    },
                },
            },
        }, parent);
        new k8s.core.v1.Service("redis-leader", {
            metadata: { name: "redis-leader", namespace, labels: redisLeaderLabels },
            spec: {
                ports: [{ name: "redis", port: 6379, targetPort: 6379 }],
                selector: redisLeaderDeployment.spec.template.metadata.labels,
            },
        }, parent);

        // redis replica
        const redisReplicaLabels = { app: "redis-replica", tier: "backend" };
        const redisReplicaDeployment = new k8s.apps.v1.Deployment("redis-replica", {
            metadata: { name: "redis-replica", namespace },
            spec: {
                selector: { matchLabels: redisReplicaLabels },
                template: {
                    metadata: { labels: redisReplicaLabels },
                    spec: {
                        containers: [
                            {
                                name: "replica",
                                image: "pulumi/guestbook-redis-replica",
                                resources: { requests: { cpu: "100m", memory: "100Mi" } },
                                env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                                ports: [{ containerPort: 6379 }],
                            },
                            redisExporter(),
                        ],
                    },
                },
            },
        }, parent);
        new k8s.core.v1.Service("redis-replica", {
            metadata: { name: "redis-replica", namespace, labels: redisReplicaLabels },
            spec: {
                ports: [{ name: "redis", port: 6379, targetPort: 6379 }],
                selector: redisReplicaDeployment.spec.template.metadata.labels,
            },
        }, parent);

        // frontend: turn on apache mod_status (localhost only) for the apache exporter sidecar
        const apacheStatusConf = new k8s.core.v1.ConfigMap("frontend-apache-status", {
            metadata: { namespace },
            data: {
                "zz-server-status.conf": [
                    "<IfModule !status_module>",
                    "    LoadModule status_module /usr/lib/apache2/modules/mod_status.so",
                    "</IfModule>",
                    "ExtendedStatus On",
                    "<Location \"/server-status\">",
                    "    SetHandler server-status",
                    "    Require local",
                    "</Location>",
                    "",
                ].join("\n"),
            },
        }, parent);

        const frontendLabels = { app: "frontend", tier: "frontend" };
        const frontendDeployment = new k8s.apps.v1.Deployment("frontend", {
            metadata: { name: "frontend", namespace },
            spec: {
                selector: { matchLabels: frontendLabels },
                replicas: args.frontendReplicas,
                template: {
                    metadata: { labels: frontendLabels },
                    spec: {
                        containers: [
                            {
                                name: "frontend",
                                image: "pulumi/guestbook-php-redis",
                                resources: { requests: { cpu: "100m", memory: "100Mi" } },
                                env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                                ports: [{ name: "http", containerPort: 80 }],
                                volumeMounts: [{
                                    name: "apache-status",
                                    mountPath: "/etc/apache2/conf-enabled/zz-server-status.conf",
                                    subPath: "zz-server-status.conf",
                                    readOnly: true,
                                }],
                            },
                            {
                                name: "apache-exporter",
                                image: args.apacheExporterImage,
                                args: [
                                    "--scrape_uri=http://localhost/server-status?auto",
                                    "--web.listen-address=:9117",
                                ],
                                ports: [{ name: "metrics", containerPort: 9117 }],
                                resources: { requests: { cpu: "10m", memory: "16Mi" }, limits: { memory: "64Mi" } },
                            },
                        ],
                        volumes: [{ name: "apache-status", configMap: { name: apacheStatusConf.metadata.name } }],
                    },
                },
            },
        }, parent);
        this.frontendService = new k8s.core.v1.Service("frontend", {
            metadata: { name: "frontend", namespace, labels: frontendLabels },
            spec: {
                type: "LoadBalancer",
                ports: [{ name: "http", port: 80, targetPort: 80, nodePort: args.frontendNodePort }],
                selector: frontendDeployment.spec.template.metadata.labels,
            },
        }, { parent: this, dependsOn: args.loadBalancerReady });

        // metrics get their own ClusterIP services so they aren't on the public frontend service
        const tiers: Array<{ app: string; tier: string; port: number }> = [
            { app: "frontend", tier: "frontend", port: 9117 },
            { app: "redis-leader", tier: "backend", port: 9121 },
            { app: "redis-replica", tier: "backend", port: 9121 },
        ];
        for (const t of tiers) {
            new k8s.core.v1.Service(`${t.app}-metrics`, {
                metadata: {
                    name: `${t.app}-metrics`,
                    namespace,
                    labels: { app: t.app, tier: t.tier, ...METRICS_LABEL },
                },
                spec: {
                    type: "ClusterIP",
                    ports: [{ name: "metrics", port: t.port, targetPort: "metrics" }],
                    selector: { app: t.app },
                },
            }, parent);
        }

        new k8s.apiextensions.CustomResource("guestbook", {
            apiVersion: "monitoring.coreos.com/v1",
            kind: "ServiceMonitor",
            metadata: { name: "guestbook", namespace, labels: { app: "guestbook" } },
            spec: {
                selector: { matchLabels: METRICS_LABEL },
                namespaceSelector: { matchNames: [args.namespace] },
                targetLabels: ["app", "tier"],
                endpoints: [{ port: "metrics", path: "/metrics", interval: "15s" }],
            },
        }, { parent: this, dependsOn: args.prometheusReady });

        // small load generator so the dashboard has something to show
        if (args.trafficGenerator) {
            new k8s.apps.v1.Deployment("traffic-generator", {
                metadata: { name: "traffic-generator", namespace },
                spec: {
                    selector: { matchLabels: { app: "traffic-generator" } },
                    replicas: 1,
                    template: {
                        metadata: { labels: { app: "traffic-generator" } },
                        spec: {
                            containers: [{
                                name: "load",
                                image: "busybox:1.36",
                                command: ["/bin/sh", "-c"],
                                args: [
                                    "i=0; while true; do i=$((i+1)); " +
                                    "wget -q -O /dev/null http://frontend/ ; " +
                                    "wget -q -O /dev/null 'http://frontend/guestbook.php?cmd=get&key=messages' ; " +
                                    "if [ $((i % 10)) -eq 0 ]; then wget -q -O /dev/null \"http://frontend/guestbook.php?cmd=set&key=messages&value=,hello-$i\"; fi; " +
                                    "sleep 0.4; done",
                                ],
                                resources: { requests: { cpu: "5m", memory: "8Mi" } },
                            }],
                        },
                    },
                },
            }, parent);
        }

        this.registerOutputs({});
    }
}
