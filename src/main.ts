import * as vscode from "vscode";
import { ItemFramework, ItemType, TestingTools } from "./util";
import { discoverTestFiles, loadTestsFromFile } from "./loader";
import { Log } from "vscode-test-adapter-util";
import { runHandler } from "./runner";
import * as util from "util";
import { v4 as uuid } from "uuid";
import * as path from "path";
import * as tmp from "tmp-promise";
import { appendFile as _appendFile } from "fs";
const appendFile = util.promisify(_appendFile);

const testReporterPath = path
    .join(__dirname, "..", "..", "src", "testthat", "reporter")
    .replace(/\\/g, "/");

const workspaceFolder = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0] : null;
if (workspaceFolder === null) {
    throw Error("Could not get the current workspace folder");
}

export async function activate(context: vscode.ExtensionContext) {
    const workspaceFolder = (vscode.workspace.workspaceFolders || [])[0];

    const controller = vscode.tests.createTestController("r-test-adapter", "R Test Adapter");
    const log = new Log("RTestAdapter", workspaceFolder, "R Test Adapter Log");
    const testItemData = new WeakMap<
        vscode.TestItem,
        { itemType: ItemType; itemFramework: ItemFramework }
    >();
    const tempFilePaths: String[] = [];

    context.subscriptions.push(controller);
    context.subscriptions.push(log);

    const testingTools: TestingTools = {
        controller,
        log,
        testItemData,
        tempFilePaths,
    };

    // Custom handler for loading tests. The "test" argument here is undefined,
    // but if we supported lazy-loading child test then this could be called with
    // the test whose children VS Code wanted to load.
    controller.resolveHandler = async (test) => {
        if (!test) {
            log.info("Discovering test files started.");
            let watcherLists = await discoverTestFiles(testingTools);
            for (const watchers of watcherLists) {
                context.subscriptions.push(...watchers);
            }
            log.info("Discovering test files finished.");
        } else {
            await loadTestsFromFile(testingTools, test);
        }
    };

    // We'll create the "run" type profile here, and give it the function to call.
    // You can also create debug and coverage profile types. The last `true` argument
    // indicates that this should by the default "run" profile, in case there were
    // multiple run profiles.
    controller.createRunProfile(
        "Run",
        vscode.TestRunProfileKind.Run,
        (request, token) => runHandler(testingTools, request, token),
        true
    );

    controller.createRunProfile(
        "Debug",
        vscode.TestRunProfileKind.Debug,
        async (request, token) => {
            const includedTests = request.include ? request.include : [];
            for (const test of includedTests) {
                const testRunId = uuid();
                let debuggerLoaderName = `.debugger-loader-${testRunId}.R`;
                let workspaceFolder = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : null;
                if (workspaceFolder === null) {
                    throw Error("Could not get the workspace folder");
                }
                let debuggerLoaderPath = path.normalize(path.join(workspaceFolder, "/", debuggerLoaderName));
                // Do not clean up tempFilePaths, not possible to get around the race condition
                testingTools.tempFilePaths.push(debuggerLoaderPath);
                // cleanup is not guaranteed to unlink the file immediately
                tmp.file({
                    name: debuggerLoaderName,
                    tmpdir: workspaceFolder,
                });
                const debuggerLoaderBody = `
                    testthat <- loadNamespace('testthat')

                    # Save the original test_that function
                    orig_test_that <- testthat::test_that

                    unlockBinding('test_that', testthat)
                    new_test_that <- function(desc, ...) {
                    if (grepl("${test.label}", desc)) {
                        orig_test_that(desc, ...)
                      } else {
                        message("Skipping test: ", desc)
                      }
                    }
                    lockBinding('test_that', testthat)

                    # Override in the testthat namespace
                    assignInNamespace("test_that", new_test_that, ns = "testthat")
                    # Optionally, update the global environment if necessary
                    assign("test_that", new_test_that, envir = .GlobalEnv)

                    devtools::load_all('${testReporterPath}')
                    devtools::load_all('${workspaceFolder}')

                    # Override test_that to only run tests whose description matches "test0"
                    .vsc.debugSource('${test.uri?.fsPath}')
                    q()
                    `

                await appendFile(debuggerLoaderPath, debuggerLoaderBody);
                const debugConfig: vscode.DebugConfiguration = {
                    type: 'R-Debugger',
                    request: 'launch',
                    name: `Debug Test: ${test.label} - ${testRunId}`,
                    debugMode: "file",
                    workingDirectory: workspaceFolder,
                    includePackageScopes: true,
                    loadPackages: ["."],
                    file: debuggerLoaderPath,
                };

                await vscode.debug.startDebugging(undefined, debugConfig);
            }
        }
    );
}
