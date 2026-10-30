/**
 * Automation to create a Kubernetes (k3s) cluster: 1 master + N workers on a private network.
 * (C) 2026 TekMonks. All rights reserved.
 * License: See enclosed LICENSE file.
 *
 * K3S_MIRROR = "" installs online from get.k3s.io; K3S_VERSION = "" then means the latest stable release.
 * K3S_MIRROR = "http://<ip>:<port>" installs offline from that mirror and needs an exact K3S_VERSION.
 * Mirror layout: install.sh, <version>/{k3s, sha256sum-amd64.txt, k3s-airgap-images-amd64.tar.zst},
 * rpm/el<major>/{container-selinux.rpm, k3s-selinux.rpm}.
 * RHEL-family images: online this is not an issue, install.sh fetches the matching SELinux RPMs itself.
 * With a mirror the RPMs must match the image's EL version - container-selinux needs a selinux-policy
 * no newer than the image has (e.g. the el9_6 build for a RHEL 9.6 image), otherwise the node stops.
 */

const SIZES = {vsmall: [1, 2048, 20], small: [2, 4096, 40], medium: [4, 8192, 80], large: [8, 16384, 160]};
const PASSWORD_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+=@-]{7,}$/;
const MASTER_IP = "10.100.0.10", K3S_VERSION = "v1.36.5+k3s1", K3S_MIRROR = "";
const WAIT_FOR_NODE_IP = "until IFACE=$(ip -o -4 addr show | awk -v ip=\"$NODE_IP/\" 'index($4, ip) == 1 {print $2}'); [ -n \"$IFACE\" ]; do sleep 5; done";

function kNodeScript(node, token, adminid) {
    const role = node.isMaster ? "server" : "agent";
    const install = !K3S_MIRROR ? "curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION=" + K3S_VERSION + " sh -s - " + role : [
        "mkdir -p /var/lib/rancher/k3s/agent/images",
        "curl -sfL -o /var/lib/rancher/k3s/agent/images/k3s-airgap-images-amd64.tar.zst " + K3S_MIRROR + "/" + K3S_VERSION + "/k3s-airgap-images-amd64.tar.zst",
        "if [ -d /usr/share/selinux ]; then . /etc/os-release; EL=el${VERSION_ID%%.*}; " +
            "{ curl -sfL -o /tmp/container-selinux.rpm " + K3S_MIRROR + "/rpm/$EL/container-selinux.rpm && curl -sfL -o /tmp/k3s-selinux.rpm " + K3S_MIRROR + "/rpm/$EL/k3s-selinux.rpm && " +
            "dnf install -y --disablerepo='*' /tmp/container-selinux.rpm /tmp/k3s-selinux.rpm; } || " +
            "{ echo \"kd-k3s: SELinux RPMs from " + K3S_MIRROR + "/rpm/$EL failed to download or install, check they match this image\" >&2; exit 1; }; fi",
        "curl -sfL " + K3S_MIRROR + "/install.sh | INSTALL_K3S_VERSION=" + K3S_VERSION + " INSTALL_K3S_ARTIFACT_URL=" + K3S_MIRROR +
            " INSTALL_K3S_SKIP_SELINUX_RPM=true INSTALL_K3S_SKIP_START=true sh -s - " + role,
        "[ -d /usr/share/selinux ] && chcon -u system_u -r object_r -t container_runtime_exec_t /usr/local/bin/k3s",
        "systemctl start " + (node.isMaster ? "k3s" : "k3s-agent")].join("\n");
    const lines = ["#!/bin/bash", "NODE_IP=" + node.ip, WAIT_FOR_NODE_IP, "mkdir -p /etc/rancher/k3s"];
    if (node.isMaster) lines.push(
        "for i in $(seq 180); do PUBLIC_IP=$(ip -o -4 addr show scope global | grep -v dynamic | awk '{split($4, a, \"/\"); print a[1]}' | grep -vxF \"$NODE_IP\" | head -1); [ -n \"$PUBLIC_IP\" ] && break; sleep 5; done",
        "printf 'token: %s\\nnode-ip: %s\\nflannel-iface: %s\\n' \"" + token + "\" \"$NODE_IP\" \"$IFACE\" > /etc/rancher/k3s/config.yaml",
        "[ -n \"$PUBLIC_IP\" ] && printf 'tls-san: [%s]\\nnode-external-ip: %s\\n' \"$PUBLIC_IP\" \"$PUBLIC_IP\" >> /etc/rancher/k3s/config.yaml",
        install,
        "until [ -f /etc/rancher/k3s/k3s.yaml ]; do sleep 5; done",
        "sed \"s/127.0.0.1/${PUBLIC_IP:-$NODE_IP}/\" /etc/rancher/k3s/k3s.yaml > /home/" + adminid + "/kubeconfig.yaml",
        "chown " + adminid + ": /home/" + adminid + "/kubeconfig.yaml && chmod 600 /home/" + adminid + "/kubeconfig.yaml");
    else lines.push(
        "printf 'server: https://%s:6443\\ntoken: %s\\nnode-ip: %s\\nflannel-iface: %s\\n' \"" + MASTER_IP + "\" \"" + token + "\" \"$NODE_IP\" \"$IFACE\" > /etc/rancher/k3s/config.yaml",
        install);
    return lines.join("\n") + "\n";
}

function cloudInit(node, token, adminid, adminpass) {
    return "{system_info: {default_user: {name: '" + adminid + "', home: /home/" + adminid + ", sudo: 'ALL=(ALL) NOPASSWD:ALL'}}, " +
        "password: '" + adminpass + "', chpasswd: {expire: false}, hostname: " + node.vm + ", ssh_pwauth: true, packages: [qemu-guest-agent], " +
        "write_files: [{path: /root/kd-k3s.sh, permissions: '0700', encoding: b64, content: " + btoa(kNodeScript(node, token, adminid)) + "}], " +
        "runcmd: [[bash, -lc, 'systemctl start qemu-guest-agent'], [bash, /root/kd-k3s.sh]]}";
}   

async function exec(params, kdcmd) {
    const [clusterName, workersRaw, nodeSize, image, adminid, adminpassRaw] = params;
    const cmdmanager = monkshu_env.apps[APP_CONSTANTS.APP_NAME].cmdmanager;
    const name = clusterName.trim().toLowerCase(), workers = Math.min(Math.max(parseInt(workersRaw) || 1, 1), 10);
    const vnet = "k8s" + name, master = "k8s" + name + "m1", ruleset = "k8s" + name + "fw";
    const random = (bytes, alphabet) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => alphabet[b % alphabet.length]).join("");
    const token = random(32, "0123456789abcdef");
    const reject = problem => {
        cmdmanager.addAlert(Date.now(), "Kubernetes cluster " + name + ": " + problem + " Nothing was created.", true);
        return false;
    };
    if (K3S_MIRROR && !K3S_VERSION) return reject("a k3s mirror is set, so K3S_VERSION must be an exact version.");

    const imageInfo = (APP_CONSTANTS.ENV?._k8sImages || []).find(entry => entry.name == image) || {name: image};
    const [ostype, imgtype] = (imageInfo.extrainfo || "").toLowerCase().split(":");
    if (ostype?.startsWith("win") || /windows/i.test(imageInfo.name + " " + (imageInfo.description || "")))
        return reject("Kubernetes nodes must run Linux, pick a Linux cloud image instead of " + (imageInfo.description || image) + ".");
    if (imgtype?.endsWith("iso")) return reject((imageInfo.description || image) + " is an installer ISO, pick a cloud image.");

    const spec = SIZES[nodeSize] || SIZES.vsmall;
    let adminpass = adminpassRaw || "";
    if (adminpass && !PASSWORD_PATTERN.test(adminpass))
        return reject("the admin password must be 8+ characters of letters, digits and . _ + = @ - only.");
    if (!adminpass) {
        adminpass = random(16, "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789");
        cmdmanager.addAlert(Date.now(), "Kubernetes cluster " + name + ": generated admin password for user " + adminid + " on all nodes: " + adminpass);
    }

    const nodes = [{vm: master, ip: MASTER_IP, isMaster: true, spec}];
    for (let i = 1; i <= workers; i++) nodes.push({vm: "k8s" + name + "w" + i, ip: "10.100.0." + (20 + i), isMaster: false, spec});

    const kd = async args => (await kdcmd(args.map(a => JSON.stringify(String(a))).join(" ")));
    const fail = step => {
        cmdmanager.addAlert(Date.now(), "Kubernetes cluster " + name + ": " + step + " failed, stopping.", true);
        return false;
    };

    if (!(await kd(["createVnet", vnet, "Kubernetes cluster " + name]))?.result) return fail("creating the network");

    for (const node of nodes)
        if (!(await kd(["createVM", node.vm, "Kubernetes " + name + (node.isMaster ? " master" : " worker"),
                node.spec[0], node.spec[1], node.spec[2], vnet, image, cloudInit(node, token, adminid, adminpass),
                "false", "", "", ""]))?.result) return fail("creating " + node.vm);

    for (const node of nodes) {
        let assigned = false;
        for (let attempt = 0; attempt < 5 && !assigned; attempt++) assigned = (await kd(["assignVnetIP", node.vm, node.ip, vnet]))?.result;
        if (!assigned) return fail("assigning the cluster IP to " + node.vm);
    }

    if (!(await kd(["assignIPToVM", master, ""]))?.result) return fail("assigning the public IP");

    const rules = [
        {direction: "in", allow: false, protocol: "udp", port: "8472", ip: "*"},
        {direction: "in", allow: false, protocol: "tcp", port: "10250", ip: "*"},
        {direction: "in", allow: false, protocol: "tcp", port: "2379-2380", ip: "*"}
    ];
    if (!(await kd(["createFirewallRuleset", ruleset, "Kubernetes " + name + " internal ports", JSON.stringify(rules)]))?.result)
        return fail("creating the firewall ruleset");
    if (!(await kd(["applyFirewallRuleset", master, ruleset]))?.result) return fail("applying the firewall ruleset");

    const publicIP = ((await kd(["listAssignedVMIPs", master]))?.ips || "").split(",")[0].trim();
    cmdmanager.addAlert(Date.now(), "Kubernetes cluster " + name + " is installing (about 5 to 10 minutes). API: https://" + publicIP +
        ":6443. Get the kubeconfig with: scp " + adminid + "@" + publicIP + ":kubeconfig.yaml .");
    return true;
}

export const automations_createkubernetescluster = {exec};
