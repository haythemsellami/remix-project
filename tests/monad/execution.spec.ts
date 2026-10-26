import { test as base, expect, Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import solc from 'solc'

const compiler = `soljson-v${solc.version().split('.Emscripten')[0]}.js`
const source = readFileSync('libs/remix-monad/examples/MonadDemo.sol', 'utf8')
const storeLine = source.split('\n').findIndex(line => line.includes('value = newValue;')) + 1
type Fork = 'monad-next' | 'monad-ten' | 'osaka'

const test = base.extend<{ diagnostics: void }>({
  diagnostics: [async ({ page }, use, testInfo) => {
    const messages: string[] = []
    page.on('console', message => {
      if (['warning', 'error'].includes(message.type()) && messages.length < 200) messages.push(`${message.type()}: ${message.text()}`)
    })
    page.on('pageerror', error => messages.push(`pageerror: ${error.stack}`))
    await use()
    await testInfo.attach('browser-diagnostics', { body: messages.join('\n'), contentType: 'text/plain' })
  }, { auto: true }]
})

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    ;(window as any).__IS_E2E_TEST__ = true
    ;(window as any).__REMIX_COMPILER_URLS__ = {
      binURL: `${location.origin}/__monad-tests__`, wasmURL: `${location.origin}/__monad-tests__`
    }
  })
  await page.route('https://binaries.soliditylang.org/**/list.json', route => route.fulfill({
    path: 'dist/apps/remix-ide/__monad-tests__/list.json', contentType: 'application/json'
  }))
  await page.goto(`/#activate=solidity,udapp,debugger,filePanel&version=${compiler}`, { waitUntil: 'domcontentloaded' })
  // Hover help can overlap controls while panels move during debugging.
  await page.addStyleTag({ content: '[role="tooltip"] { pointer-events: none !important; }' })
  await expect(page.locator('[data-id="workspaceloaded"]')).toBeAttached({ timeout: 60_000 })
  await expect(page.locator('[data-id="apploaded"]')).toBeAttached()
  await expect(page.locator('[data-id="treeViewUltreeViewMenu"]')).toBeVisible()
  await page.locator('[data-id="fileExplorerLocalFileSystemUpload"]').setInputFiles('libs/remix-monad/examples/MonadDemo.sol')
  await page.locator('[data-id="treeViewLitreeViewItemMonadDemo.sol"]').click()
  await page.locator('#icon-panel div[plugin="solidity"]').click()
  await expect(page.locator('[data-id="compilerloaded"]')).toBeAttached({ timeout: 60_000 })
  await page.locator('[data-id="scConfigExpander"]').click()
  await page.locator('#evmVersionSelector').selectOption('cancun')
  await page.locator('[data-id="compilerContainerCompileBtn"]').click()
  await expect(page.locator('[data-id="compiledContracts"]')).toContainText('MonadDemo')
})

async function selectEnvironment(page: Page, fork: Fork) {
  await page.locator('#icon-panel div[plugin="udapp"]').click()
  await page.locator('[data-id="settingsSelectEnvCategoryOptions"]').click()
  await page.locator(`[data-id="dropdown-item-vm-${fork}"]`).click()
  await expect(page.locator(`[data-id="selected-provider-vm-${fork}"]`)).toBeVisible()
  await expect(page.locator('[data-id="runTabSelectAccount"]')).toContainText(fork === 'osaka' ? 'ETH' : 'MON', { timeout: 60_000 })
}

async function deploy(page: Page) {
  await page.getByRole('tab', { name: 'Deploy', exact: true }).click()
  await page.locator('[data-id="contractDropdownToggle"]').click()
  await page.locator('[data-id="contractDropdownItem-MonadDemo"]').click()
  await page.locator('[data-id="deployButton"]').click()
  await expect(page.locator('[data-id="deployedContractsBadge"]')).toHaveText('1')
  if (!await page.locator('[data-id="terminalJournal"]').isVisible()) {
    await page.locator('[data-id="toggleBottomPanelIcon"]').click()
  }
  return page.locator('[data-shared="txLoggerDebugButton"]').last().getAttribute('data-id')
}

async function debugTransaction(page: Page, buttonId: string) {
  await page.locator(`[data-id="${buttonId}"]`).click()
  await expect(page.locator('[data-id="txStatus"]')).toHaveText('Success')
  // Wait for source loading to position the debugger at the function entry.
  await expect(page.locator('[data-id="btnStepBack"]')).toBeEnabled()
}

async function showOpcodes(page: Page) {
  await page.getByRole('button', { name: 'Stack & Memory', exact: true }).click()
  if (!await page.locator('.opcodes-container').isVisible()) {
    await page.locator('.json-line').filter({ has: page.locator('.json-key', { hasText: /^opcode$/ }) }).locator('i').click()
  }
  await expect(page.locator('.opcodes-container')).toBeVisible()
}

const currentOpcode = (page: Page) => page.locator('.opcodes-container .opcode-item[style*="background-color"]')

async function step(page: Page, direction: 'forward' | 'back') {
  const header = page.locator('[data-id="callTraceHeader"]')
  const current = Number((await header.innerText()).match(/Step: (\d+) /)[1])
  await page.locator(`[data-id="${direction === 'forward' ? 'btnStepInto' : 'btnStepBack'}"]`).click()
  const next = current + (direction === 'forward' ? 1 : -1)
  await expect(header).toHaveText(new RegExp(`\\(Step: ${next} / \\d+\\)`))
}

async function openContract(page: Page) {
  await page.locator('#icon-panel div[plugin="udapp"]').click()
  await page.getByRole('tab', { name: /^Deployed Contracts\b/ }).click()
  if (!await page.locator('[data-id="functionList-0"]').isVisible()) {
    await page.locator('[data-id="deployedContractItem-0"]').click()
  }
}

function contractFunction(page: Page, name: string) {
  return page.locator('[data-id^="deployedContractItem-0-function-"]').filter({ has: page.locator(`[title="${name}"]`) })
}

async function transact(page: Page, name: string, argument?: string) {
  const buttons = page.locator('[data-shared="txLoggerDebugButton"]')
  const count = await buttons.count()
  const row = contractFunction(page, name)
  if (argument !== undefined) await row.locator('input').fill(argument)
  await row.getByRole('button', { name: 'Transact', exact: true }).click()
  await expect(buttons).toHaveCount(count + 1)
  return buttons.last().getAttribute('data-id')
}

async function readValue(page: Page, value: number) {
  const row = contractFunction(page, 'value')
  await row.getByRole('button', { name: 'Call', exact: true }).click()
  await expect(row.locator('[data-id="udapp_tree_value"]')).toContainText(new RegExp(`uint256: ${value}\\b`))
}

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
