import type { DeployInputs, Scripts } from '../src/deploy.ts';
export function addressData(bech32: string): string;
export function compileDeployment(p: DeployInputs): { compiler: string; scripts: Scripts };
