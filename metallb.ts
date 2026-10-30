import { execSync } from "child_process";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export interface MetallbArgs {
    chartVersion: string;
    // e.g. "172.18.255.200-172.18.255.250". Detected from the kind docker network if empty.
    addressRange?: string;
    dockerNetwork: string;
}

// Takes the top of the kind network's IPv4 subnet, which docker doesn't hand out to containers.
function detectAddressRange(network: string): string {
    let out: string;
    try {
        out = execSync(`docker network inspect ${network} -f "{{range .IPAM.Config}}{{.Subnet}} {{end}}"`,
            { encoding: "utf8" });
    } catch (e) {
        throw new Error(`could not inspect docker network "${network}". Is the kind cluster running? ` +
            `You can also set the range yourself: pulumi config set metallbAddressRange <start>-<end>`);
    }
    const cidr = out.split(/\s+/).find(s => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(s));
    if (!cidr) {
        throw new Error(`no IPv4 subnet found on docker network "${network}"`);
    }
    const [ip, bits] = cidr.split("/");
    const base = ip.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
    const size = 2 ** (32 - Number(bits));
    const broadcast = (base + size - 1) >>> 0;
    const toIp = (n: number) => [24, 16, 8, 0].map(s => (n >>> s) & 255).join(".");
    return `${toIp(broadcast - 55)}-${toIp(broadcast - 5)}`;
}

export class Metallb extends pulumi.ComponentResource {
    public readonly ready: pulumi.Resource[];
    public readonly addressRange: string;

    constructor(name: string, args: MetallbArgs, opts?: pulumi.ComponentResourceOptions) {
        super("guestbook:infra:Metallb", name, {}, opts);

        this.addressRange = args.addressRange || detectAddressRange(args.dockerNetwork);

        const ns = new k8s.core.v1.Namespace(name, {
            metadata: {
                name: "metallb-system",
                labels: {
                    "pod-security.kubernetes.io/enforce": "privileged",
                    "pod-security.kubernetes.io/audit": "privileged",
                    "pod-security.kubernetes.io/warn": "privileged",
                },
            },
        }, { parent: this });

        const release = new k8s.helm.v3.Release(name, {
            name: "metallb",
            chart: "metallb",
            version: args.chartVersion,
            namespace: ns.metadata.name,
            repositoryOpts: { repo: "https://metallb.github.io/metallb" },
            values: {
                // the webhook may not be serving yet when the IP pool is created right after install
                crds: { validationFailurePolicy: "Ignore" },
                speaker: {
                    frr: { enabled: false }, // L2 mode only, no BGP
                    // kind's only node is a control-plane node, which carries the
                    // exclude-from-external-load-balancers label
                    ignoreExcludeLB: true,
                },
            },
        }, { parent: this });

        const pool = new k8s.apiextensions.CustomResource(`${name}-pool`, {
            apiVersion: "metallb.io/v1beta1",
            kind: "IPAddressPool",
            metadata: { name: "kind-pool", namespace: ns.metadata.name },
            spec: { addresses: [this.addressRange] },
        }, { parent: this, dependsOn: [release] });

        const l2 = new k8s.apiextensions.CustomResource(`${name}-l2`, {
            apiVersion: "metallb.io/v1beta1",
            kind: "L2Advertisement",
            metadata: { name: "kind-l2", namespace: ns.metadata.name },
            spec: { ipAddressPools: ["kind-pool"] },
        }, { parent: this, dependsOn: [release] });

        this.ready = [release, pool, l2];
        this.registerOutputs({});
    }
}
