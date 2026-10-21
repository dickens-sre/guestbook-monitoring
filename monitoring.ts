import * as fs from "fs";
import * as path from "path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

export interface MonitoringArgs {
    namespace: string;
    grafanaServiceType: "LoadBalancer" | "NodePort" | "ClusterIP";
    grafanaNodePort: number;
    grafanaAdminUser: string;
    grafanaAdminPassword?: pulumi.Input<string>;
    chartVersion: string;
    appNamespace: string;
}

export class Monitoring extends pulumi.ComponentResource {
    public readonly release: k8s.helm.v3.Release;
    public readonly grafanaUrl: pulumi.Output<string>;
    public readonly grafanaAdminUser: pulumi.Output<string>;
    public readonly grafanaAdminPassword: pulumi.Output<string>;
    public readonly prometheusPortForward: pulumi.Output<string>;

    constructor(name: string, args: MonitoringArgs, opts?: pulumi.ComponentResourceOptions) {
        super("guestbook:monitoring:Monitoring", name, {}, opts);

        const ns = new k8s.core.v1.Namespace(name, {
            metadata: { name: args.namespace },
        }, { parent: this });

        // use the configured password, or generate one
        const adminPassword: pulumi.Output<string> = args.grafanaAdminPassword
            ? pulumi.secret(pulumi.output(args.grafanaAdminPassword))
            : new random.RandomPassword(`${name}-grafana-admin`, {
                length: 20,
                special: false,
            }, { parent: this }).result;

        const grafanaService: Record<string, unknown> = { type: args.grafanaServiceType, port: 80 };
        if (args.grafanaServiceType === "NodePort") {
            grafanaService.nodePort = args.grafanaNodePort;
        }

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
                        // pick up ServiceMonitors from all namespaces, not only ones
                        // labelled with this helm release
                        serviceMonitorSelectorNilUsesHelmValues: false,
                        podMonitorSelectorNilUsesHelmValues: false,
                        ruleSelectorNilUsesHelmValues: false,
                    },
                },
                grafana: {
                    adminUser: args.grafanaAdminUser,
                    adminPassword: adminPassword,
                    service: grafanaService,
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
        }, { parent: this });

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

        const grafanaSvc = k8s.core.v1.Service.get(
            `${name}-grafana-svc`,
            pulumi.interpolate`${this.release.status.namespace}/${this.release.status.name}-grafana`,
            { parent: this, dependsOn: [this.release] },
        );

        switch (args.grafanaServiceType) {
            case "LoadBalancer":
                this.grafanaUrl = grafanaSvc.status.apply(s => {
                    const ing = s?.loadBalancer?.ingress?.[0];
                    const host = ing?.ip || ing?.hostname;
                    return host ? `http://${host}` : "pending";
                });
                break;
            case "NodePort":
                this.grafanaUrl = pulumi.interpolate`http://<node-ip>:${grafanaSvc.spec.ports[0].nodePort}`;
                break;
            default:
                this.grafanaUrl = pulumi.output("http://localhost:3000 (via port-forward)");
        }

        this.grafanaAdminUser = pulumi.output(args.grafanaAdminUser);
        this.grafanaAdminPassword = pulumi.secret(adminPassword);
        this.prometheusPortForward = pulumi.output(
            `kubectl -n ${args.namespace} port-forward svc/prometheus-operated 9090:9090`,
        );

        this.registerOutputs({
            grafanaUrl: this.grafanaUrl,
            grafanaAdminUser: this.grafanaAdminUser,
            grafanaAdminPassword: this.grafanaAdminPassword,
        });
    }
}
