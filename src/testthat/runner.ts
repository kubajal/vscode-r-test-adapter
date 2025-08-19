import * as path from "path";
import * as vscode from "vscode";
import { getDevtoolsVersion, getRscriptCommand, TestingTools } from "../util";
import { appendFile as _appendFile } from "fs";

const testReporterPath = path
    .join(__dirname, "..", "..", "..", "src", "testthat", "reporter")
    .replace(/\\/g, "/");
const workspaceFolder = vscode.workspace.workspaceFolders![0].uri.fsPath
    .replace(/\\/g, "/");

// This function returns the 'entry point' for the R test.
// The entry point hacks the testthat package to disable any other test.
// This way the user has a seamless experience when running the test
// both in the normal and debug mode.
export async function testthatEntryPoint(
    testingTools: TestingTools,
    test: vscode.TestItem,
    isDebug: boolean = false,
    isWholeFile: boolean) {

    let RscriptCommand = await getRscriptCommand(testingTools);
    let { major, minor, patch } = await getDevtoolsVersion(testingTools, RscriptCommand);
    if (major < 2 || (major == 2 && minor < 3) || (major == 2 && minor == 3 && patch < 2)) {
        return Promise.reject(
            Error(
                "Devtools version too old. RTestAdapter requires devtools>=2.3.2" +
                "to be installed in the Rscript environment"
            )
        );
    };
    let devtoolsMethod = major == 2 && minor < 4 ? "test_file" : "test_active_file";

    let selectors: string[] = [];
    while (test.parent != undefined) {
        selectors = selectors.concat([test?.label]);
        test = test.parent;
    }
    const testPath = test?.uri!.fsPath
        .replace(/\\/g, "/");

    return `
# NOTE! This file has been generated automatically by the VSCode R Test Adapter. Modification has no effect.

# This file modifies the original behavior of the testthat::test_that and testthat::describe methods
# such that they trigger only the tests specified by the 'desc' argument.
# Please report any unwanted effects at https://github.com/meakbiyik/vscode-r-test-adapter/issues.

# Entry point for the '${test.id}' test follows...

IS_DEBUG <- ${Number(isDebug)}

devtools::load_all('${testReporterPath}')

library(devtools)
if (IS_DEBUG) {
    .vsc.load_all('${workspaceFolder}')
    print(the$selected_description)
    the$selected_description <- c(${selectors.map((x) => `"^${x}$"`).join(", ")})
    with_reporter(VSCodeReporter, {
        .vsc.debugSource('${testPath}')
    })
} else {
    devtools::load_all('${workspaceFolder}')
    devtools::${devtoolsMethod}('${testPath}', reporter=VSCodeReporter)
}
`;
}
