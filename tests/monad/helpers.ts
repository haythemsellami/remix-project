import { test as base, expect, Page } from '@playwright/test'
import solc from 'solc'
import { routeScriptRunner } from './script-runner'

const compiler = `soljson-v${solc.version().split('.Emscripten')[0]}.js`
type Fork = 'monad-next' | 'monad-ten' | 'osaka'

export const test = base.extend<{ diagnostics: void; ide: void; contractFile: string; scriptRunner: boolean }>({
  contractFile: ['MonadDemo.sol', { option: true }],
  scriptRunner: [false, { option: true }],
  diagnostics: [async ({ page }, use, testInfo) => {
    const messages: string[] = []
    page.on('console', message => {
      if (['warning', 'error'].includes(message.type()) && messages.length < 200) messages.push(`${message.type()}: ${message.text()}`)
    })
    page.on('pageerror', error => messages.push(`pageerror: ${error.stack}`))
    await use()
    await testInfo.attach('browser-diagnostics', { body: messages.join('\n'), contentType: 'text/plain' })
  }, { auto: true }],
  ide: [async ({ page, contractFile, diagnostics, scriptRunner }, use) => {
    if (scriptRunner) await routeScriptRunner(page)
    await prepareIde(page, contractFile)
    await use()
  }, { auto: true }]
})

async function prepareIde(page: Page, contractFile: string) {
  await page.addInitScript(() => {
    ;(window as any).__IS_E2E_TEST__ = true
    ;(window as any).__REMIX_COMPILER_URLS__ = {
      binURL: `${location.origin}/__monad-tests__`, wasmURL: `${location.origin}/__monad-tests__`
    }
  })
  await page.route('https://binaries.soliditylang.org/**/list.json', route => route.fulfill({
    path: 'dist/apps/remix-ide/__monad-tests__/list.json', contentType: 'application/json'
  }))
  // Keep local VM startup independent of the optional payment and survey scripts.
  await page.route(/^https:\/\/(cdn\.paddle\.com|tally\.so)\//, route => route.fulfill({ body: '', contentType: 'application/javascript' }))
  await page.route('**/console.sol', route => route.fulfill({ path: 'node_modules/hardhat/console.sol', contentType: 'text/plain' }))
  const unitTest = contractFile.endsWith('_test.sol')
  await page.goto(`/#activate=solidity,udapp,debugger,filePanel${unitTest ? ',solidityUnitTesting' : ''}&version=${compiler}`, { waitUntil: 'domcontentloaded' })
  // Hover help can overlap controls while panels move during debugging.
  await page.addStyleTag({ content: '[role="tooltip"] { pointer-events: none !important; }' })
  await expect(page.locator('[data-id="workspaceloaded"]')).toBeAttached({ timeout: 60_000 })
  await expect(page.locator('[data-id="apploaded"]')).toBeAttached()
  if (unitTest) await page.locator('#icon-panel div[plugin="filePanel"]').click()
  await expect(page.locator('[data-id="treeViewUltreeViewMenu"]')).toBeVisible()
  await page.locator('[data-id="fileExplorerLocalFileSystemUpload"]').setInputFiles(`libs/remix-monad/examples/${contractFile}`)
  await page.locator(`[data-id="treeViewLitreeViewItem${contractFile}"]`).click()
  await page.locator('#icon-panel div[plugin="solidity"]').click()
  await expect(page.locator('[data-id="compilerloaded"]')).toBeAttached({ timeout: 60_000 })
  await page.locator('[data-id="scConfigExpander"]').click()
  await page.locator('#evmVersionSelector').selectOption('cancun')
  if (!unitTest) {
    await page.locator('[data-id="compilerContainerCompileBtn"]').click()
    await expect(page.locator('[data-id="compiledContracts"]')).toContainText(contractFile.replace('.sol', ''))
  }
}

export async function selectEnvironment(page: Page, fork: Fork) {
  await page.locator('#icon-panel div[plugin="udapp"]').click()
  await page.locator('[data-id="settingsSelectEnvCategoryOptions"]').click()
  await page.locator(`[data-id="dropdown-item-vm-${fork}"]`).click()
  await expect(page.locator(`[data-id="selected-provider-vm-${fork}"]`)).toBeVisible()
  await expect(page.locator('[data-id="runTabSelectAccount"]')).toContainText(fork === 'osaka' ? 'ETH' : 'MON', { timeout: 60_000 })
}

export async function deploy(page: Page, contract = 'MonadDemo') {
  await page.getByRole('tab', { name: 'Deploy', exact: true }).click()
  await page.locator('[data-id="contractDropdownToggle"]').click()
  await page.locator(`[data-id="contractDropdownItem-${contract}"]`).click()
  await page.locator('[data-id="deployButton"]').click()
  await expect(page.locator('[data-id="deployedContractsBadge"]')).toHaveText('1')
  if (!await page.locator('[data-id="terminalJournal"]').isVisible()) {
    await page.locator('[data-id="toggleBottomPanelIcon"]').click()
  }
  return page.locator('[data-shared="txLoggerDebugButton"]').last().getAttribute('data-id')
}

export async function debugTransaction(page: Page, buttonId: string, status = 'Success') {
  await page.locator(`[data-id="${buttonId}"]`).click()
  await expect(page.locator('[data-id="txStatus"]')).toHaveText(status)
  // Wait for source loading to position the debugger at the function entry.
  await expect(page.locator('[data-id="btnStepBack"]')).toBeEnabled()
}

export async function showOpcodes(page: Page) {
  await page.getByRole('button', { name: 'Stack & Memory', exact: true }).click()
  if (!await page.locator('.opcodes-container').isVisible()) {
    await page.locator('.json-line').filter({ has: page.locator('.json-key', { hasText: /^opcode$/ }) }).locator('i').click()
  }
  await expect(page.locator('.opcodes-container')).toBeVisible()
}

export const currentOpcode = (page: Page) => page.locator('.opcodes-container .opcode-item[style*="background-color"]')

export async function step(page: Page, direction: 'forward' | 'back') {
  const header = page.locator('[data-id="callTraceHeader"]')
  const current = Number((await header.innerText()).match(/Step: (\d+) /)[1])
  await page.locator(`[data-id="${direction === 'forward' ? 'btnStepInto' : 'btnStepBack'}"]`).click()
  const next = current + (direction === 'forward' ? 1 : -1)
  await expect(header).toHaveText(new RegExp(`\\(Step: ${next} / \\d+\\)`))
}

export async function openContract(page: Page) {
  if (!await page.getByRole('tab', { name: /^Deployed Contracts\b/ }).isVisible()) {
    await page.locator('#icon-panel div[plugin="udapp"]').click()
  }
  await page.getByRole('tab', { name: /^Deployed Contracts\b/ }).click()
  if (!await page.locator('[data-id="functionList-0"]').isVisible()) {
    await page.locator('[data-id="deployedContractItem-0"]').click()
  }
}

export function contractFunction(page: Page, name: string) {
  return page.locator('[data-id^="deployedContractItem-0-function-"]').filter({ has: page.locator(`[title="${name}"]`) })
}

export async function transact(page: Page, name: string, argument?: string) {
  const buttons = page.locator('[data-shared="txLoggerDebugButton"]')
  const count = await buttons.count()
  const row = contractFunction(page, name)
  if (argument !== undefined) await row.locator('input').fill(argument)
  await row.getByRole('button', { name: 'Transact', exact: true }).click()
  await expect(buttons).toHaveCount(count + 1)
  return buttons.last().getAttribute('data-id')
}

export async function readValue(page: Page, value: number) {
  const row = contractFunction(page, 'value')
  await row.getByRole('button', { name: 'Call', exact: true }).click()
  await expect(row.locator('[data-id="udapp_tree_value"]')).toContainText(new RegExp(`uint256: ${value}\\b`))
}
