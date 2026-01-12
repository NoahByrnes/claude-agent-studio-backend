import { Sandbox } from '@e2b/sdk';

const sandbox = await Sandbox.create({
  template: 'u1ocastbc39b4xfhfsiz',
  apiKey: 'e2b_64b4b0526178e05ca58e5f93fdedf2cbb9726993',
  timeout: 60000,
});

console.log('✅ Sandbox created:', sandbox.id);

// Test if Claude CLI is installed
const result = await sandbox.process.startAndWait({
  cmd: 'claude --version',
});

console.log('Exit code:', result.exitCode);
console.log('Output:', result.stdout);
console.log('Errors:', result.stderr);

await sandbox.close();
