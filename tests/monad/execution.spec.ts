import { expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { test, selectEnvironment, deploy, debugTransaction, showOpcodes, currentOpcode, step, openContract, transact, readValue } from './helpers'

const source = readFileSync('libs/remix-monad/examples/MonadDemo.sol', 'utf8')
const storeLine = source.split('\n').findIndex(line => line.includes('value = newValue;')) + 1

for (const fork of ['monad-next', 'monad-ten', 'osaka'] as const) {
  test(`${fork}: deploy, store and debug through the IDE`, async ({ page }) => {
    await test.step('Deploy and navigate constructor instructions in both directions', async () => {
      await selectEnvironment(page, fork)
      await debugTransaction(page, await deploy(page))
      await showOpcodes(page)
      const instruction = await currentOpcode(page).innerText()
      await step(page, 'forward')
      await step(page, 'back')
      await expect(currentOpcode(page)).toHaveText(instruction)
      await page.getByRole('button', { name: 'Stop debugging', exact: true }).click()
    })

    await test.step('Write storage, read it back and inspect the Solidity assignment', async () => {
      await openContract(page)
      const transaction = await transact(page, 'store', '42')
      await readValue(page, 42)
      await debugTransaction(page, transaction)
      await showOpcodes(page)
      for (let i = 0; i < 80 && !/\bSSTORE\b/.test(await currentOpcode(page).innerText()); i++) {
        await step(page, 'forward')
      }
      await expect(currentOpcode(page)).toContainText('SSTORE')
      await expect(page.locator(`#editorView .highlightLine${storeLine}`).first()).toBeVisible()
      await step(page, 'forward')
      await page.getByRole('button', { name: 'State & Locals', exact: true }).click()
      const state = page.locator('[data-id="solidityState"]')
      await state.locator('[data-id="state-expand-icon"]').click()
      await state.locator('[data-id="value-expand-icon"]').click()
      await expect(state.locator('[data-id="value-json-nested"] [data-id="value-json-value"]')).toHaveText('"42"')
      await page.getByRole('button', { name: 'Stop debugging', exact: true }).click()
    })

    if (fork === 'monad-next') {
      await test.step('Execute CALLSTACKDEPTH and inspect its two-byte instruction and stack effect', async () => {
        await openContract(page)
        const transaction = await transact(page, 'recordDepth')
        await readValue(page, 1)
        await debugTransaction(page, transaction)
        await showOpcodes(page)
        for (let i = 0; i < 80 && !/\bSTATICCALL\b/.test(await currentOpcode(page).innerText()); i++) {
          await step(page, 'forward')
        }
        await expect(currentOpcode(page)).toContainText('STATICCALL')
        await step(page, 'forward')
        await expect(currentOpcode(page)).toHaveText(/^\s*0+\s+CALLSTACKDEPTH\s*$/)
        await step(page, 'forward')
        await expect(currentOpcode(page)).toHaveText(/^\s*0*2\s+PUSH0(?:\s+0x)?\s*$/)
        await page.locator('[data-id="stack-expand-icon"]').click()
        await expect(page.locator('[data-id="stack-json-nested"]')).toContainText('0000000000000000000000000000000000000000000000000000000000000001')
        await step(page, 'back')
        await expect(currentOpcode(page)).toHaveText(/^\s*0+\s+CALLSTACKDEPTH\s*$/)
        await expect(page.locator('.json-line').filter({ has: page.locator('.json-key', { hasText: /^stack$/ }) })).toHaveText(/stack\s*:\s*\[\s*\]/)
        await step(page, 'forward')
        await expect(currentOpcode(page)).toHaveText(/^\s*0*2\s+PUSH0(?:\s+0x)?\s*$/)
        await expect(page.locator('[data-id="stack-json-nested"]')).toContainText('0000000000000000000000000000000000000000000000000000000000000001')
      })
    }
  })
}
