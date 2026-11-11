#!/bin/bash

CLONE_CREATED=false
CLONE_PATHS=()

function exitFailed() {
    if [ "$CLONE_CREATED" == "true" ]; then
        echo Removing the partially created clone {2}
        sudo virsh undefine {2} --nvram
        sudo rm -f "${CLONE_PATHS[@]}" /kloudust/metadata/{2}.metadata /kloudust/metadata/{2}.xml
    fi
    echo Failed
    exit 1
}

printf "Cloning VM {1} to {2}\n"
for SRC in `sudo virsh domblklist {1} --details | awk '$2=="disk" {print $4}'`; do
    if [[ "$SRC" != "/kloudust/disks/{1}."* && "$SRC" != "/kloudust/disks/{1}_"* ]]; then
        echo Error!! Disk $SRC is not named after {1}, unable to name its clone.
        exitFailed
    fi
    CLONE_PATHS+=("/kloudust/disks/{2}${SRC#"/kloudust/disks/{1}"}")
done
if [ ${#CLONE_PATHS[@]} -eq 0 ]; then echo Error!! No disks found for {1}.; exitFailed; fi
CLONE_FILES=(); for P in "${CLONE_PATHS[@]}"; do CLONE_FILES+=(--file "$P"); done
if ! sudo virt-clone --original {1} --name {2} "${CLONE_FILES[@]}"; then exitFailed; fi
CLONE_CREATED=true

printf "\n\nResetting clone identity\n"
if ! sudo virt-sysprep --domain {2} --hostname "{3}" \
    --operations customize,machine-id,ssh-hostkeys,udev-persistent-net,net-hostname,net-hwaddr \
    --run-command 'ssh-keygen -A' \
    --run-command 'if [ -f /etc/netplan/50-cloud-init.yaml ]; then sed -i "/^[[:space:]]*match:/,/^[[:space:]]*dhcp4:/ { /^[[:space:]]*dhcp4:/!d; }" /etc/netplan/50-cloud-init.yaml && sed -i "/^[[:space:]]*set-name:/d" /etc/netplan/50-cloud-init.yaml; fi' \
    --run-command 'rm -f /etc/netplan/99-kd-ip-*.yaml /etc/NetworkManager/system-connections/kd-ip-*.nmconnection'; then exitFailed; fi

printf "\n\nGenerating metadata\n"
sudo bash -c "cat <<EOF > /kloudust/metadata/{2}.metadata
NAME={2}
EOF"
cat /kloudust/metadata/{1}.metadata | grep -v NAME | sudo tee -a /kloudust/metadata/{2}.metadata > /dev/null
if ! sudo virsh dumpxml {2} > /kloudust/metadata/{2}.xml; then exitFailed; fi

printf "Enabling autostart"
if ! sudo virsh autostart {2}; then exitFailed; fi

printf "\n\nClone successful\n"
exit 0
