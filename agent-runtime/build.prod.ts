import { Template, defaultBuildLogger } from 'e2b'
import { template } from './template'

async function main() {
  console.log('🏗️  Building E2B template for production...')

  const result = await Template.build(template, {
    alias: 'claude-agent-studio-nb',
    onBuildLogs: defaultBuildLogger(),
  });

  console.log('\n✅ Template built successfully!')
  console.log(`   Template ID: ${result}`)
  console.log('\n🚀 Production Deployment:')
  console.log('   1. Set E2B_API_KEY in Railway environment')
  console.log(`   2. Set E2B_TEMPLATE_ID=${result}`)
  console.log('   3. Set BACKEND_API_URL to your Railway backend URL')
  console.log('   4. Set INTERNAL_API_KEY to a secure random key')
}

main().catch(console.error);