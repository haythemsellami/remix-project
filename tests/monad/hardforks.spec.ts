import { expect } from '@playwright/test'
import { test, selectEnvironment, showOpcodes, currentOpcode, step } from './helpers'
import { rpc } from './persistence-helpers'

for (const fork of ['monad-eight', 'monad-nine'] as const) {
  test(`${fork}: debug CLZ activation and rejected extension instructions`, async ({ page }) => {
    await selectEnvironment(page, fork)
    const [from] = await rpc(page, 'eth_accounts')
    for (const runtime of ['60011e5f5260205ff3', 'ae005f5260205ff3']) {
      const clz = runtime.startsWith('6001')
      const success = clz && fork === 'monad-nine'
      const length = (runtime.length / 2).toString(16).padStart(2, '0')
      const deployment = await rpc(page, 'eth_sendTransaction', { from, gas: '0xf4240', data: `0x60${length}600c60003960${length}6000f3${runtime}` })
      const address = (await rpc(page, 'eth_getTransactionReceipt', deployment)).contractAddress
      const hash = await rpc(page, 'eth_sendTransaction', { from, to: address, gas: '0xf4240' })
      const trace = await rpc(page, 'debug_traceTransaction', hash)
      expect(trace.fork).toBe(fork)
      const opcode = success ? 'CLZ' : 'INVALID'
      const pc = clz ? 2 : 0
      expect(trace.structLogs.find(entry => entry.pc === pc).op).toBe(opcode)
      if (success) expect(BigInt(trace.returnValue)).toBe(255n)

      const input = page.locator('[data-id="debuggerTransactionInput"]')
      if (!await input.isVisible()) await page.locator('#icon-panel div[plugin="debugger"]').click()
      await input.fill(hash)
      await page.getByRole('button', { name: 'Start debugging', exact: true }).click()
      await expect(page.locator('[data-id="txStatus"]')).toHaveText(success ? 'Success' : 'Failed')
      await showOpcodes(page)
      if (clz) await step(page, 'forward')
      await expect(currentOpcode(page)).toHaveText(new RegExp(`^\\s*0*${pc}\\s+${opcode}\\s*$`))
      if (success) {
        await step(page, 'forward')
        await expect(currentOpcode(page)).toContainText('PUSH0')
        await page.locator('[data-id="stack-expand-icon"]').click()
        await expect(page.locator('[data-id="stack-json-nested"]')).toContainText('ff'.padStart(64, '0'))
        await step(page, 'back')
        await expect(currentOpcode(page)).toContainText('CLZ')
      }
      await page.getByRole('button', { name: 'Stop debugging', exact: true }).click()
    }
  })
}
