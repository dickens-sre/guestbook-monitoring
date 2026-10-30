import * as pulumi from "@pulumi/pulumi";
import { Guestbook } from "./guestbook";
import { Metallb } from "./metallb";
import { lbAddress, Monitoring } from "./monitoring";

const config = new pulumi.Config();

const appNamespace = config.get("appNamespace") ?? "guestbook";
const monitoringNamespace = config.get("monitoringNamespace") ?? "monitoring";

// node ports must match kind-config.yaml
const ports = { frontend: 30080, grafana: 30300, prometheus: 30090 };

// MetalLB gives LoadBalancer services an IP on kind. Turn it off on a cloud cluster.
const useMetallb = config.getBoolean("metallb") ?? true;
const metallb = useMetallb
    ? new Metallb("metallb", {
        chartVersion: config.get("metallbVersion") ?? "0.15.3",
        addressRange: config.get("metallbAddressRange"),
        dockerNetwork: config.get("kindDockerNetwork") ?? "kind",
    })
    : undefined;
const lbReady = metallb?.ready ?? [];

const grafanaAdminUser = config.get("grafanaAdminUser") ?? "admin";
const grafanaAdminPassword = config.get("grafanaAdminPassword") ?? "guestbook123";

const monitoring = new Monitoring("monitoring", {
    namespace: monitoringNamespace,
    chartVersion: config.get("kubePrometheusStackVersion") ?? "65.1.1",
    appNamespace,
    grafanaAdminUser,
    grafanaAdminPassword,
    grafanaNodePort: ports.grafana,
    prometheusNodePort: ports.prometheus,
}, { dependsOn: lbReady });

const guestbook = new Guestbook("guestbook", {
    namespace: appNamespace,
    frontendReplicas: config.getNumber("frontendReplicas") ?? 3,
    frontendNodePort: ports.frontend,
    redisExporterImage: config.get("redisExporterImage") ?? "oliver006/redis_exporter:v1.62.0",
    apacheExporterImage: config.get("apacheExporterImage") ?? "lusotycoon/apache-exporter:v1.1.1",
    trafficGenerator: config.getBoolean("trafficGenerator") ?? true,
    loadBalancerReady: lbReady,
    prometheusReady: [monitoring.release],
});

export const guestbookUrl = pulumi.interpolate`http://${lbAddress(guestbook.frontendService)}`;
export const grafanaUrl = monitoring.grafanaUrl;
export const prometheusUrl = monitoring.prometheusUrl;
export { grafanaAdminUser, grafanaAdminPassword };

// same services through kind's port mappings, these work on macOS/Windows too
export const localUrls = {
    guestbook: `http://localhost:${ports.frontend}`,
    grafana: `http://localhost:${ports.grafana}`,
    prometheus: `http://localhost:${ports.prometheus}`,
};

export const metallbAddressRange = metallb?.addressRange;
