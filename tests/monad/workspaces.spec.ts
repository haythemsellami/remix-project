import { expect, Page } from '@playwright/test'
import { test } from './helpers'
import { rpc, chooseEnvironment, changeProvider, waitForSaved, reload, compileExisting, deployAndStore, observe, expiredFilters, debugSaved } from './persistence-helpers'

test.describe.configure({ timeout: 180_000 })

async function switchWorkspace(page: Page, name: string, create = false) {
  await changeProvider(page, async () => {
    await page.locator('[data-id="workspacesSelect"]').click()
    if (create) {
      await page.locator('[data-id="workspacecreate"]').click()
      await page.locator('[data-id="create-blank-workspace-topcard"]').click()
      await page.locator('[data-id="workspace-name-blank-input"]').fill(name)
      await page.locator('[data-id="initializeAsGitRepo-blank"]').uncheck()
      await page.locator('[data-id="validate-blankworkspace-button"]').click()
    } else {
      await page.locator(`[data-id="dropdown-item-${name}"]`).click()
    }
    await expect(page.locator('[data-id="workspacesSelect-togglerText"]')).toHaveText(name)
  })
}

for (const fork of ['monad-ten', 'monad-next'] as const) {
  test(`${fork}: workspaces restore independent state and debugging history`, async ({ page }) => {
    await chooseEnvironment(page, fork)
    const first = await deployAndStore(page, 11)
    const expectedFirst = await observe(page, first)
    await waitForSaved(page, fork)
    const filter = await rpc(page, 'eth_newFilter', {})
    const workspace = `isolated-${fork}`
    await switchWorkspace(page, workspace, true)
    await chooseEnvironment(page, fork)
    expect(await rpc(page, 'eth_getCode', first.address, 'latest')).toBe('0x')
    expect(await rpc(page, 'eth_getTransactionReceipt', first.stored)).toBeNull()
    expect(await rpc(page, 'eth_getLogs', { fromBlock: 'earliest' })).toEqual([])
    await expiredFilters(page, [filter])
    if (!await page.locator('[data-id="treeViewUltreeViewMenu"]').isVisible()) await page.locator('#icon-panel div[plugin="filePanel"]').click()
    // Select a root file so the explorer has an upload destination in the new workspace.
    const rootFile = page.locator('[data-id="treeViewLitreeViewItemremix.config.json"]')
    await rootFile.click()
    await expect(rootFile).toHaveClass(/remixui_selected/)
    await page.locator('[data-id="fileExplorerLocalFileSystemUpload"]').setInputFiles('libs/remix-monad/examples/MonadDemo.sol')
    await compileExisting(page)
    const second = await deployAndStore(page, 22)
    expect(second.address).toBe(first.address)
    expect(second.stored).not.toBe(first.stored)
    const expectedSecond = await observe(page, second)
    await waitForSaved(page, fork, workspace)

    await switchWorkspace(page, 'default_workspace')
    expect(await observe(page, first)).toEqual(expectedFirst)
    expect(await rpc(page, 'eth_getTransactionReceipt', second.stored)).toBeNull()
    await compileExisting(page)
    await debugSaved(page, first.stored, 11)
    await switchWorkspace(page, workspace)
    expect(await observe(page, second)).toEqual(expectedSecond)
    expect(await rpc(page, 'eth_getTransactionReceipt', first.stored)).toBeNull()
    await reload(page, fork)
    await expect(page.locator('[data-id="workspacesSelect-togglerText"]')).toHaveText(workspace)
    expect(await observe(page, second)).toEqual(expectedSecond)
    await compileExisting(page)
    await debugSaved(page, second.stored, 22)
  })
}

test('Ethereum Osaka: workspace switches replace the VM and restore its saved contracts', async ({ page }) => {
  await chooseEnvironment(page, 'osaka')
  const first = await deployAndStore(page, 11)
  const [from] = await rpc(page, 'eth_accounts')
  const code = await rpc(page, 'eth_getCode', first.address, 'latest')
  const nonce = await rpc(page, 'eth_getTransactionCount', from, 'latest')
  await waitForSaved(page, 'osaka')
  await switchWorkspace(page, 'isolated-osaka', true)
  expect(BigInt(await rpc(page, 'eth_getTransactionCount', from, 'latest'))).toBe(0n)
  expect(await rpc(page, 'eth_getCode', first.address, 'latest')).toBe('0x')
  await switchWorkspace(page, 'default_workspace')
  expect(await rpc(page, 'eth_getCode', first.address, 'latest')).toBe(code)
  expect(await rpc(page, 'eth_getTransactionCount', from, 'latest')).toBe(nonce)
})
