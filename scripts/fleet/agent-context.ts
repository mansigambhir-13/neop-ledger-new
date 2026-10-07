import { createAgentContext, verifyAgentContext } from './packaging/agent-context.ts';
const [mode, output] = process.argv.slice(2);
if (!output || !['build', 'verify'].includes(mode ?? '') || process.argv.length !== 4) throw new Error('usage: node --import tsx scripts/fleet/agent-context.ts build|verify NEW_CONTEXT_DIRECTORY');
const artifact = mode === 'build' ? await createAgentContext(output) : await verifyAgentContext(output);
console.log(JSON.stringify({ apps: artifact.apps, dependencies: artifact.dependencies.length, files: artifact.inventory.length, unresolvedPeers: artifact.dependencies.filter(d => d.unresolvedPeers.length).map(d => ({ name: d.name, peers: d.unresolvedPeers })), production_ready: false }, null, 2));
