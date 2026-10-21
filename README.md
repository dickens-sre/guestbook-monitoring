# Guestbook with Prometheus and Grafana

Deployment of Pulumi Guestbook app on Kubernetes and monitor what is happening inside the cluster.

Things added:

- **Prometheus and Grafana:** Installed using the `kube-prometheus-stack` Helm chart.
- **Redis monitoring:** Added `redis_exporter` to both redis_leader and redis_replica as sidecar running on port `9121`.
- **Frontend monitoring:** Enabled Apache `mod_status` and added an `apache_exporter` sidecar on port `9117`.
- **Prometheus scraping:** The `ServiceMonitor` tells Prometheus where to collect metrics from the Guestbook services.
- **Grafana dashboard:** The `Guestbook Overview` dashboard is loaded automatically and it shows request rate, Redis commands, pod CPU and memory, ready pods, and restarts.
- **Grafana access:** Grafana uses a NodePort on local kind clusters and a LoadBalancer on cloud clusters.

## Requirements

You need to install the following:

- Docker Desktop
- [kind](https://kind.sigs.k8s.io/)
- kubectl
- Node.js 18+
- [Pulumi CLI](https://www.pulumi.com/docs/install/)

## Setup

### 1. Create the Kubernetes cluster

I'm using kind for the local setup.

```bash
kind create cluster --name guestbook
kubectl cluster-info --context kind-guestbook
```

### 2. Install dependencies

From the project directory, run:

```bash
npm install
```

### 3. Configure Pulumi

First, set a passphrase for your local Pulumi secrets and log in locally.

```bash
export PULUMI_CONFIG_PASSPHRASE="choose-a-passphrase"
pulumi login --local
pulumi stack init dev
```

Since kind doesn't come with a cloud LoadBalancer, set these two options:

```bash
pulumi config set isMinikube true
pulumi config set trafficGenerator true
```

`isMinikube` configures the frontend as a ClusterIP service and Grafana as a NodePort service.

`trafficGenerator` deploys a small pod that sends requests to the frontend. This gives us some traffic to work with when checking the dashboard.

**If you're using a cloud cluster** like EKS, GKE, or AKS, skip those two configuration commands. The frontend and Grafana will use LoadBalancer services instead.

### 4. Deploy the application

```bash
pulumi up
```

Review the changes and select `yes` to continue.

The first deployment will take about 5 minutes.

### 5. Check that the pods are running

```bash
kubectl -n guestbook get pods
kubectl -n monitoring get pods
```

The frontend and Redis pods should show `2/2` in the READY column. One container runs the application, and the other runs its exporter.

### 6. Open the Guestbook

Forward the frontend service to your local machine:

```bash
kubectl -n guestbook port-forward svc/frontend 8080:80
```

Open [http://localhost:8080](http://localhost:8080) in your browser.

## Grafana

### Access Grafana

Get the connection details from Pulumi:

```bash
pulumi stack output grafanaUrl
pulumi stack output grafanaAdminUser
pulumi stack output grafanaAdminPassword --show-secrets
```

The default username is `admin`. The password is generated during deployment and stored as a Pulumi secret.

If you want to set your own password, do this before running `pulumi up`:

```bash
pulumi config set --secret grafanaAdminPassword <password>
```

### Open Grafana on kind

Since kind doesn't provide a LoadBalancer, forward the Grafana service to your machine:

```bash
kubectl -n monitoring port-forward svc/kps-grafana 3000:80
```

Open [http://localhost:3000](http://localhost:3000) and log in.

Go to **Dashboards → Guestbook → Guestbook Overview**.

You should see the metrics collected from the Guestbook application.

If you're using a cloud cluster, check the `grafanaUrl` output and open the LoadBalancer address directly.

## Verify Prometheus is collecting metrics

Let's check that Prometheus can actually see the Guestbook metrics.

### 1. Check the ServiceMonitor and metrics services

```bash
kubectl -n guestbook get servicemonitor
kubectl -n guestbook get svc -l monitoring.guestbook/scrape=true
```

These should show the ServiceMonitor and the services exposing application metrics.

### 2. Check Prometheus targets

Forward the Prometheus service:

```bash
kubectl -n monitoring port-forward svc/prometheus-operated 9090:9090
```

Open [http://localhost:9090/targets](http://localhost:9090/targets) and search for `guestbook`.

You should see 5 targets in the UP state:

- 3 frontend pods
- 1 Redis leader
- 1 Redis replica

### 3. Try some Prometheus queries

Open the Prometheus Graph page and run these queries.

Check which targets are up:

```promql
up{namespace="guestbook"}
```

Check the frontend request rate:

```promql
sum(rate(apache_accesses_total{namespace="guestbook"}[2m]))
```

Check Redis command rates:

```promql
sum by (app) (rate(redis_commands_processed_total{namespace="guestbook"}[2m]))
```

Check CPU usage by pod:

```promql
sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="guestbook", container!=""}[2m]))
```

If the traffic generator is enabled, you should have traffic to work with when testing these queries.

### 4. Check an exporter directly (optional)

You can also query the frontend exporter from inside the cluster:

```bash
kubectl -n guestbook run curl --rm -it \
  --restart=Never \
  --image=curlimages/curl -- \
  curl -s frontend-metrics:9117/metrics | grep apache_accesses_total
```

This is useful when you want to check whether the exporter is exposing metrics before troubleshooting Prometheus.

## Project structure

| File | What it does |
|---|---|
| `index.ts` | Reads the configuration, creates the two components, and exports the outputs. |
| `monitoring.ts` | Deploys `kube-prometheus-stack`, configures the Grafana service, and creates the dashboard ConfigMap. |
| `guestbook.ts` | Creates the Guestbook deployments and services, exporter sidecars, metrics services, and ServiceMonitor. |
| `grafana/guestbook-dashboard.json` | Contains the Grafana dashboard definition. |

## Notes

- The Guestbook app doesn't expose HTTP status codes as metrics, so the dashboard uses container restarts instead of an HTTP error rate.
- Other configuration options include `grafanaServiceType`, `grafanaNodePort`, `grafanaAdminUser`, `frontendReplicas`, and `kubePrometheusStackVersion`.

## Clean up

When you're done testing, remove the resources created by Pulumi and delete the kind cluster.

```bash
pulumi destroy
pulumi stack rm dev
kind delete cluster --name guestbook
```

That's it. You now have a Kubernetes Guestbook application with Prometheus collecting metrics and Grafana displaying them on a dashboard.