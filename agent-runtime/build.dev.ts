#!/usr/bin/env tsx

/**
 * Development build script for E2B template
 *
 * Usage: npm run build:dev
 */

import template from './template'

async function build() {
  console.log('🏗️  Building E2B template for development...')
  console.log('   Name: claude-agent-studio')

  try {
    // Build the template
    const result = await template.build({ name: 'claude-agent-studio' })

    console.log('✅ Template built successfully!')
    console.log(`   Template: ${result}`)

    // Save template ID to .env for easy access
    console.log('\n💡 Add this to your backend .env file:')
    console.log(`   E2B_TEMPLATE_ID=${result}`)

    return result
  } catch (error) {
    console.error('❌ Template build failed:', error)
    process.exit(1)
  }
}

build()
