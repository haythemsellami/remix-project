import { expect, Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { test, selectEnvironment, deploy, debugTransaction, showOpcodes, currentOpcode, step, openContract, transact, readValue, contractFunction } from './helpers'

test.use({ contractFile: 'NestedCalls.sol' })
const source = readFileSync('libs/remix-monad/examples/NestedCalls.sol', 'utf8')
const delegateLine = source.split('\n').findIndex(line => line.includes('value = 41;')) + 1

async function expandCalls(page: Page) {
  const collapsed = page.locator('.call-trace-expand-icon.fa-plus-square')
  for (let i = 0; i < 20 && await collapsed.count(); i++) await collapsed.first().click()
}

async function untilOpcode(page: Page, opcode: string) {
  for (let i = 0; i < 200 && !new RegExp(`\\b${opcode}\\b`).test(await currentOpcode(page).innerText()); i++) {
    await step(page, 'forward')
  }
  await expect(currentOpcode(page)).toContainText(opcode)
}

async function decodedValue(page: Page, value: number) {
  await page.getByRole('button', { name: 'State & Locals', exact: true }).click()
  const state = page.locator('[data-id="solidityState"]')
  for (const key of ['state', 'value']) {
    const toggle = state.locator(`[data-id="${key}-expand-icon"]`)
    await expect(toggle).toBeVisible()
    if ((await toggle.getAttribute('class')).includes('fa-plus-square')) await toggle.click()
  }
  await expect(state.locator('[data-id="value-json-nested"] [data-id="value-json-value"]')).toHaveText(`"${value}"`)
}

for (const fork of ['monad-next', 'monad-ten', 'osaka'] as const) {
  test(`${fork}: navigate nested calls, delegate storage and caught reverts`, async ({ page }) => {
    await selectEnvironment(page, fork)
    await deploy(page, 'NestedCalls')

    await test.step('Select a delegated call and inspect the caller storage with the callee source', async () => {
      await openContract(page)
      const transaction = await transact(page, 'delegateStore')
      await readValue(page, 43)
      await debugTransaction(page, transaction)
      await expandCalls(page)
      const delegated = page.locator('.call-trace-item').filter({ has: page.locator('[data-id="call-trace-type-delegatecall"]') })
      await expect(delegated).toHaveCount(1)
      await delegated.click()
      await showOpcodes(page)
      await expect(currentOpcode(page)).toContainText('DELEGATECALL')
      await step(page, 'forward')
      await untilOpcode(page, 'SSTORE')
      await expect(page.locator(`#editorView .highlightLine${delegateLine}`).first()).toBeVisible()
      await step(page, 'forward')
      await decodedValue(page, 41)
      await showOpcodes(page)
      await step(page, 'back')
      await expect(currentOpcode(page)).toContainText('SSTORE')
      await decodedValue(page, 10)
      await page.getByRole('button', { name: 'Stop debugging', exact: true }).click()
    })

    await test.step('Navigate a reverted child and return to the successful parent', async () => {
      await openContract(page)
      const transaction = await transact(page, 'caughtRevert')
      await readValue(page, 11)
      await debugTransaction(page, transaction)
      await expandCalls(page)
      const calls = page.locator('.call-trace-item').filter({ has: page.locator('[data-id="call-trace-type-call"]') })
      await expect(calls).toHaveCount(3)
      await calls.nth(1).click()
      await showOpcodes(page)
      await expect(currentOpcode(page)).toContainText('CALL')
      await step(page, 'forward')
      await calls.nth(1).locator('button').filter({ has: page.locator('i.fa-step-forward') }).click()
      await expect(currentOpcode(page)).toContainText('REVERT')
      await decodedValue(page, 20)
      await showOpcodes(page)
      await step(page, 'forward')
      await decodedValue(page, 10)
      await showOpcodes(page)
      await step(page, 'back')
      await expect(currentOpcode(page)).toContainText('REVERT')
      await decodedValue(page, 20)
      await page.getByRole('button', { name: 'Stop debugging', exact: true }).click()
    })

    if (fork === 'monad-next') {
      await test.step('Select the raw-bytecode STATICCALL in the call tree', async () => {
        await openContract(page)
        const callee = contractFunction(page, 'callee')
        await callee.getByRole('button', { name: 'Call', exact: true }).click()
        const result = callee.locator('[data-id="udapp_tree_value"]')
        await expect(result).toContainText(/0x[0-9a-f]{40}/i)
        const address = await result.innerText()
        const callerWord = address.match(/0x[0-9a-f]{40}/i)[0].slice(2).toLowerCase().padStart(64, '0')
        const transaction = await transact(page, 'inspect', '1')
        await debugTransaction(page, transaction)
        await expandCalls(page)
        const oracle = page.locator('.call-trace-item').filter({ has: page.locator('[data-id="call-trace-type-staticcall"]') })
        await expect(oracle).toHaveCount(1)
        await oracle.click()
        await showOpcodes(page)
        await expect(currentOpcode(page)).toContainText('STATICCALL')
        await step(page, 'forward')
        await expect(currentOpcode(page)).toHaveText(/^\s*0+\s+CALLSTACKDEPTH\s*$/)
        await untilOpcode(page, 'CALLERN')
        await step(page, 'forward')
        await page.locator('[data-id="stack-expand-icon"]').click()
        const stack = page.locator('[data-id="stack-json-nested"]')
        await expect(stack).toContainText(callerWord)
        await oracle.locator('button').filter({ has: page.locator('i.fa-sign-out-alt') }).click()
        await expect(currentOpcode(page)).toContainText('RETURN')
        await step(page, 'forward')
        await expect(currentOpcode(page)).not.toContainText('RETURN')
        await step(page, 'back')
        await expect(currentOpcode(page)).toContainText('RETURN')
      })
    }
  })
}
