// Build-time values only: never place private keys in NX_* variables.
export const ensTestMode = process.env.NX_ENS_TEST_MODE === 'true'
export const ensParentName = process.env.NX_ENS_PARENT_NAME || 'remixcontract.eth'
export const ensDappParentName = process.env.NX_ENS_DAPP_PARENT_NAME || 'remixdapp.eth'

export function validateEnsTestEnvironment(baseUrl: string): void {
  if (!ensTestMode) return
  const base = new URL(baseUrl)
  if (!['http:', 'https:'].includes(base.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
    throw new Error('ENS test mode requires a loopback API URL')
  }
  for (const name of [ensParentName, ensDappParentName]) {
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.eth$/.test(name) ||
        ['remixcontract.eth', 'remixdapp.eth'].some(root => name === root || name.endsWith(`.${root}`))) {
      throw new Error('ENS test mode requires explicit, non-production parent names')
    }
  }
}

export function assertEnsReverseEnabled(): void {
  if (ensTestMode) throw new Error('Reverse registration is disabled in the local ENS test profile')
}

/** Local names are not served by public eth.limo. Use the local RPC to verify them. */
export function ensWebsiteUrl(name: string): string {
  return ensTestMode ? '' : `https://${name}.limo`
}
