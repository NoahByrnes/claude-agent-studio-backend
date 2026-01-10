import { Template, defaultBuildLogger } from 'e2b'
import { template } from './template'

async function main() {
  console.log('🏗️  Building E2B template for Claude Agent Studio...')

  const result = await Template.build(template, {
    alias: 'claude-agent-studio-nb',
    onBuildLogs: defaultBuildLogger(),
  });

  console.log('\n✅ Template built successfully!')
  console.log(`   Template ID: ${result}`)
  console.log('\n💡 Add this to your backend .env file:')
  console.log(`   E2B_TEMPLATE_ID=${result}`)
}

main().catch(console.error);