import * as vscode from "vscode";
import { ItemFramework, ItemType, TestingTools } from "./util";
import { discoverTestFiles, loadTestsFromFile } from "./loader";
import { Log } from "vscode-test-adapter-util";
import { runHandler } from "./runner";
import * as path from "path";
import { appendFile as _appendFile } from "fs";

const testReporterPath = path
    .join(__dirname, "..", "..", "src", "testthat", "reporter")
    .replace(/\\/g, "/");

const workspaceFolder = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0] : null;
if (workspaceFolder === null) {
    throw Error("Could not get the current workspace folder");
}

function getDebuggerEntryPoint(test: vscode.TestItem) {
    return `
testthat <- loadNamespace('testthat')

# Save the original test_that function
orig_test_that <- testthat::test_that

unlockBinding('test_that', testthat)
new_test_that <- function(desc, ...) {
if (grepl('${test.label}', desc)) {
    orig_test_that(desc, ...)
  } else {
    message('Skipping test: ', desc)
  }
}
lockBinding('test_that', testthat)

# Override in the testthat namespace
assignInNamespace('test_that', new_test_that, ns = 'testthat')
# Optionally, update the global environment if necessary
assign('test_that', new_test_that, envir = .GlobalEnv)

devtools::load_all('${testReporterPath}')
devtools::load_all('${workspaceFolder?.uri.fsPath}')

# Override test_that to only run tests whose description matches "test0"
library(vscDebugger)
print('Started listening for debugging connections...')
.vsc.listenForDAP()
print('Got a debugging connection...')
Sys.sleep(5)
.vsc.debugSource('${test.uri?.fsPath}')
browser()
print('Finished executing test ${test.uri?.fsPath}')
`;
}

function getPlainRunEntryPoint(test: vscode.TestItem) {
    return `
devtools::load_all('${testReporterPath}');
devtools::load_all('${workspaceFolder?.uri.fsPath}');
testthat::test_file('${test.uri?.fsPath}', desc = '${test.label}', reporter = VSCodeReporter);`;
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
        (request, token) => runHandler(testingTools, request, token, getPlainRunEntryPoint),
        true
    );

    controller.createRunProfile(
        "Debug",
        vscode.TestRunProfileKind.Debug,
        (request, token) => runHandler(testingTools, request, token, getDebuggerEntryPoint),
        true
    );
}
