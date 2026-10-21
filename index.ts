import * as pulumi from "@pulumi/pulumi";
import { Guestbook } from "./guestbook";
import { Monitoring } from "./monitoring";

const config = new pulumi.Config();

// kind/minikube don't support LoadBalancer services
const isMinikube = config.getBoolean("isMinikube") ?? false;

type ServiceType = "LoadBalancer" | "NodePort" | "ClusterIP";
const grafanaServiceType = (config.get("grafanaServiceType") || (isMinikube ? "NodePort" : "LoadBalancer")) as ServiceType;

const appNamespace = config.get("appNamespace") ?? "guestbook";
const monitoringNamespace = config.get("monitoringNamespace") ?? "monitoring";

const monitoring = new Monitoring("monitoring", {
    namespace: monitoringNamespace,
    chartVersion: config.get("kubePrometheusStackVersion") ?? "65.1.1",
    grafanaServiceType,
    grafanaNodePort: config.getNumber("grafanaNodePort") ?? 30300,
    grafanaAdminUser: config.get("grafanaAdminUser") ?? "admin",
    grafanaAdminPassword: config.getSecret("grafanaAdminPassword"),
    appNamespace,
});

const guestbook = new Guestbook("guestbook", {
    namespace: appNamespace,
    isMinikube,
    frontendReplicas: config.getNumber("frontendReplicas") ?? 3,
    redisExporterImage: config.get("redisExporterImage") ?? "oliver006/redis_exporter:v1.62.0",
    apacheExporterImage: config.get("apacheExporterImage") ?? "lusotycoon/apache-exporter:latest",
    trafficGenerator: config.getBoolean("trafficGenerator") ?? false,
}, { monitoringReady: [monitoring.release] });

export const frontendIp = guestbook.frontendIp;
export const guestbookNamespace = guestbook.namespace;

export const grafanaUrl = monitoring.grafanaUrl;
export const grafanaAdminUser = monitoring.grafanaAdminUser;
export const grafanaAdminPassword = monitoring.grafanaAdminPassword;
export const grafanaPortForward = `kubectl -n ${monitoringNamespace} port-forward svc/kps-grafana 3000:80`;
export const prometheusPortForward = monitoring.prometheusPortForward;
