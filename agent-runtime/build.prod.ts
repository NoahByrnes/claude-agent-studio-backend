#!/usr/bin/env tsx

/**
 * Production build script for E2B template
 *
 * Usage: npm run build:prod
 */

import template from './template'

async function build() {
  console.log('🏗️  Building E2B template for production...')
  console.log('   Name: claude-agent-studio')

  try {
    // Build the template with production settings
    const result = await template.build({
      name: 'claude-agent-studio',
      // No cache for clean production build
      noCache: true,
    })

    console.log('✅ Template built successfully!')
    console.log(`   Template: ${result}`)

    // Production reminder
    console.log('\n🚀 Production Deployment:')
    console.log('   1. Set E2B_API_KEY in Railway environment')
    console.log(`   2. Set E2B_TEMPLATE_ID=${result}`)
    console.log('   3. Set BACKEND_API_URL to your Railway backend URL')
    console.log('   4. Set INTERNAL_API_KEY to a secure random key')

    return result
  } catch (error) {
    console.error('❌ Template build failed:', error)
    process.exit(1)
  }
}

build()
