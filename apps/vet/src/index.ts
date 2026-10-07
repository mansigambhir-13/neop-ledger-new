import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Manifest} from '@neop/contracts';
import {loadAgentDir,loadBlocks,type AppDefinition} from '@neop/template';
import {abilities} from './capabilities/index.ts';
export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const manifest=JSON.parse(readFileSync(path.join(ROOT,'manifest.json'),'utf8')) as Manifest;
export async function vetApp():Promise<AppDefinition> {
 const {prompt,skills}=await loadAgentDir(path.join(ROOT,'src/agent'));
 return {manifest,migrationsDir:path.join(ROOT,'migrations'),abilities,prompt,skills,blocks:await loadBlocks(ROOT,manifest.blocks)};
}
