import * as fs from "fs";
import * as path from "path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export interface MonitoringArgs {
    namespace: string;
    chartVersion: string;
    appNamespace: string;
    grafanaAdminUser: string;
    grafanaAdminPassword: string;
    grafanaNodePort: number;
    prometheusNodePort: number;
}

// External address of a LoadBalancer service (IP from MetalLB, hostname on some clouds).
export function lbAddress(svc: k8s.core.v1.Service): pulumi.Output<string> {
    return svc.status.loadBalancer.ingress.apply(i => i?.[0]?.ip || i?.[0]?.hostname || "pending");
}

export class Monitoring extends pulumi.ComponentResource {
    public readonly release: k8s.helm.v3.Release;
    public readonly grafanaUrl: pulumi.Output<string>;
    public readonly prometheusUrl: pulumi.Output<string>;

    constructor(name: string, args: MonitoringArgs, opts?: pulumi.ComponentResourceOptions) {
        super("guestbook:monitoring:Monitoring", name, {}, opts);

        const ns = new k8s.core.v1.Namespace(name, {
            metadata: { name: args.namespace },
        }, { parent: this });

        const releaseName = "kps";

        this.release = new k8s.helm.v3.Release(name, {
            name: releaseName,
            chart: "kube-prometheus-stack",
            version: args.chartVersion,
            namespace: ns.metadata.name,
            repositoryOpts: { repo: "https://prometheus-community.github.io/helm-charts" },
            timeout: 900,
            values: {
                fullnameOverride: releaseName,
                alertmanager: { enabled: false },
                prometheus: {
                    prometheusSpec: {
                        scrapeInterval: "15s",
                        retention: "2d",
                        // pick up ServiceMonitors from every namespace, not just ones labelled for this release
                        serviceMonitorSelectorNilUsesHelmValues: false,
                        podMonitorSelectorNilUsesHelmValues: false,
                        ruleSelectorNilUsesHelmValues: false,
                    },
                },
                grafana: {
                    adminUser: args.grafanaAdminUser,
                    adminPassword: args.grafanaAdminPassword,
                    sidecar: {
                        dashboards: {
                            enabled: true,
                            label: "grafana_dashboard",
                            labelValue: "1",
                            searchNamespace: "ALL",
                            folderAnnotation: "grafana_folder",
                            provider: { foldersFromFilesStructure: true },
                        },
                    },
                },
            },
        }, { parent: this, dependsOn: opts?.dependsOn });

        // the grafana sidecar loads any ConfigMap with the grafana_dashboard label
        const dashboardJson = fs
            .readFileSync(path.join(__dirname, "grafana", "guestbook-dashboard.json"), "utf8")
            .replace(/__APP_NAMESPACE__/g, args.appNamespace);

        new k8s.core.v1.ConfigMap(`${name}-guestbook-dashboard`, {
            metadata: {
                name: "guestbook-dashboard",
                namespace: ns.metadata.name,
                labels: { grafana_dashboard: "1" },
                annotations: { grafana_folder: "Guestbook" },
            },
            data: { "guestbook-dashboard.json": dashboardJson },
        }, { parent: this, dependsOn: [this.release] });

        // Our own LoadBalancer services so the node ports are fixed and match kind-config.yaml.
        const grafanaLb = new k8s.core.v1.Service(`${name}-grafana-lb`, {
            metadata: { name: "grafana-lb", namespace: ns.metadata.name },
            spec: {
                type: "LoadBalancer",
                selector: { "app.kubernetes.io/name": "grafana", "app.kubernetes.io/instance": releaseName },
                ports: [{ name: "http", port: 80, targetPort: 3000, nodePort: args.grafanaNodePort }],
            },
        }, { parent: this, dependsOn: [this.release] });

        const prometheusLb = new k8s.core.v1.Service(`${name}-prometheus-lb`, {
            metadata: { name: "prometheus-lb", namespace: ns.metadata.name },
            spec: {
                type: "LoadBalancer",
                selector: {
                    "app.kubernetes.io/name": "prometheus",
                    "operator.prometheus.io/name": `${releaseName}-prometheus`,
                },
                ports: [{ name: "http", port: 9090, targetPort: 9090, nodePort: args.prometheusNodePort }],
            },
        }, { parent: this, dependsOn: [this.release] });

        this.grafanaUrl = pulumi.interpolate`http://${lbAddress(grafanaLb)}`;
        this.prometheusUrl = pulumi.interpolate`http://${lbAddress(prometheusLb)}:9090`;

        this.registerOutputs({ grafanaUrl: this.grafanaUrl, prometheusUrl: this.prometheusUrl });
    }
}
