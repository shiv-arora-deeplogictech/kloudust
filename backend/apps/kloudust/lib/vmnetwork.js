/**
 * Kloudust's VM network handler. Works on the VM side of the networks - Vnets,
 * firewalls etc. of a VM - using the regular Vnet and firewall commands.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See enclosed LICENSE file.
 */
const addVMVnet = require(`${KLOUD_CONSTANTS.LIBDIR}/cmd/addVMVnet.js`);
const createVnet = require(`${KLOUD_CONSTANTS.LIBDIR}/cmd/createVnet.js`);
const dbAbstractor = require(`${KLOUD_CONSTANTS.LIBDIR}/dbAbstractor.js`);
const CMD_CONSTANTS = require(`${KLOUD_CONSTANTS.LIBDIR}/cmd/cmdconstants.js`);
const applyFirewallRuleset = require(`${KLOUD_CONSTANTS.LIBDIR}/cmd/applyFirewallRuleset.js`);
const createFirewallRuleset = require(`${KLOUD_CONSTANTS.LIBDIR}/cmd/createFirewallRuleset.js`);

const VNET_VM_RELATION = "vnetvm";

/**
 * Replicates the Vnets and firewalls of a VM onto another VM. The Internet backbone
 * Vnet is skipped as public IPs are not replicated. Private IPs are not replicated.
 * @param {string} from_vm_name The resolved name of the VM to replicate from
 * @param {string} to_vm_name The resolved name of the VM to replicate to
 * @param {object} consoleHandlers The Kloudust console handlers object
 * @returns {result: true|false, out, err, stdout, stderr}
 */
exports.replicate = async function(from_vm_name, to_vm_name, consoleHandlers) {
    const to_vm = await dbAbstractor.getVM(to_vm_name);
    if (!to_vm) {consoleHandlers.LOGERROR(`VM ${to_vm_name} not found`); return CMD_CONSTANTS.FALSE_RESULT();}

    const backbone = createVnet.resolveVnetName(createVnet.getInternetBackboneVnet());
    for (const vnet_id of await dbAbstractor.getVnetsForResource(from_vm_name, VNET_VM_RELATION) || []) {
        const vnet_name = (await dbAbstractor.getVnetName(vnet_id))?.name;
        if ((!vnet_name) || (vnet_name == backbone)) continue;
        const vnet_name_raw = createVnet.unresolveVnetName(vnet_name);  // the commands take raw names
        const addResult = await _exec(addVMVnet, [to_vm.name_raw, vnet_name_raw], consoleHandlers);
        if (!addResult.result) return addResult;

        for (const ruleset_id of await dbAbstractor.getVMVnetFirewall(from_vm_name, vnet_name) || []) {
            const ruleset = await dbAbstractor.getFirewallRulesetById(ruleset_id); if (!ruleset) continue;
            const applyResult = await _exec(applyFirewallRuleset, [to_vm.name_raw,
                createFirewallRuleset.unresolveRulesetName(ruleset.name), vnet_name_raw], consoleHandlers);
            if (!applyResult.result) return applyResult;
        }
    }
    return CMD_CONSTANTS.TRUE_RESULT();
}

function _exec(cmd, params, consoleHandlers) {params.consoleHandlers = consoleHandlers; return cmd.exec(params);}
