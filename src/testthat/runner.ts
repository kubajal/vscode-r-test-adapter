import * as path from "path";
import * as winreg from "winreg";
import * as fs from "fs";
import { spawn } from "child_process";
import * as vscode from "vscode";
import * as split2 from "split2";
import { encodeNodeId } from "./util";
import { ItemType, TestingTools } from "../util";
import { appendFile as _appendFile } from "fs";
import { lookpath } from "lookpath";
import { TestResult } from "./reporter";
import testthatParser from "./parser";

const testReporterPath = path
    .join(__dirname, "..", "..", "..", "src", "testthat", "reporter")
    .replace(/\\/g, "/");
let RscriptPath: string | undefined;

async function runTest(
    testingTools: TestingTools,
    run: vscode.TestRun,
    test: vscode.TestItem
): Promise<string> {
    const getType = (testItem: vscode.TestItem) =>
        testingTools.testItemData.get(testItem)!.itemType;

    switch (getType(test)) {
        case ItemType.File:
            testingTools.log.info("Test type is file");
            // If we're running a file and don't know what it contains yet, parse it now
            if (test.children.size === 0) {
                testingTools.log.info("Children are not yet available. Parsing children.");
                await testthatParser(testingTools, test);
            }
            // Run the file - it is faster than running tests one by one
            testingTools.log.info("Run test file as a whole.");
            return runSingleTestFile(testingTools, run, test, false);
        case ItemType.TestCase:
            testingTools.log.info("Test type is test case and a single test");
            return runSingleTest(testingTools, run, test);
    }
}

async function runSingleTestFile(
    testingTools: TestingTools,
    run: vscode.TestRun,
    test: vscode.TestItem,
    isSingleTest: boolean
): Promise<string> {
    const filePath = test.uri ? test.uri.fsPath : null;
    if (filePath === null) {
        throw Error("Could not get the current test path");
    }
    testingTools.log.info(
        `Started running${isSingleTest ? " single" : ""} test file in path ${filePath}`
    );
    let cleanFilePath = filePath.replace(/\\/g, "/");
    let projectDirMatch = cleanFilePath.match(/(.+?)\/tests\/testthat.+?/i);
    let RscriptCommand = await getRscriptCommand(testingTools);
    let { major, minor, patch } = await getDevtoolsVersion(testingTools, RscriptCommand);
    if (major < 2 || (major == 2 && minor < 3) || (major == 2 && minor == 3 && patch < 2)) {
        return Promise.reject(
            Error(
                "Devtools version too old. RTestAdapter requires devtools>=2.3.2" +
                "to be installed in the Rscript environment"
            )
        );
    }
    const workspaceFolder = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0] : null;
    if (workspaceFolder === null) {
        throw Error("Could not get the current workspace folder");
    }
    // const testLabel = test.label
    let devtoolsCall =
        `devtools::load_all('${testReporterPath}');` +
        `devtools::load_all('${workspaceFolder.uri.fsPath}');` +
        `testthat::test_file('${filePath}',desc='${test.label}',reporter=VSCodeReporter)`;
    let command = `${RscriptCommand} -e "${devtoolsCall}"`;
    let cwd = projectDirMatch
        ? projectDirMatch[1]
        : vscode.workspace.workspaceFolders![0].uri.fsPath;
    testingTools.log.info(`Running test file in path ${filePath} in working directory ${cwd}`);
    return new Promise<string>(async (resolve, reject) => {
        let childProcess = spawn(command, { cwd, shell: true });
        let stdout = "";
        let testStartDates = new WeakMap<vscode.TestItem, number>();
        childProcess
            .stdout!.pipe(
                split2((line: string) => {
                    try {
                        return JSON.parse(line) as TestResult;
                    } catch {
                        return line + "\r\n";
                    }
                })
            )
            .on("data", function (data: TestResult | string) {
                stdout += JSON.stringify(data);
                if (typeof data === "string") {
                    run.appendOutput(data, undefined, test);
                    return;
                }
                switch (data.type) {
                    case "start_test":
                        if (data.test !== undefined) {
                            let testItem = isSingleTest
                                ? test
                                : findTestRecursively(
                                    encodeNodeId(test.uri!.fsPath, data.test),
                                    test
                                );
                            if (testItem === undefined)
                                reject(
                                    `Test with id ${encodeNodeId(
                                        test.uri!.fsPath,
                                        data.test
                                    )} could not be found. Please report this.`
                                );
                            testStartDates.set(testItem!, Date.now());
                            run.started(testItem!);
                        }
                        break;
                    case "add_result":
                        if (data.result !== undefined && data.test !== undefined) {
                            let testItem = isSingleTest
                                ? test
                                : findTestRecursively(
                                    encodeNodeId(test.uri!.fsPath, data.test),
                                    test
                                );
                            if (testItem === undefined)
                                reject(
                                    `Test with id ${encodeNodeId(
                                        test.uri!.fsPath,
                                        data.test
                                    )} could not be found. Please report this.`
                                );
                            let duration = Date.now() - testStartDates.get(testItem!)!;
                            switch (data.result) {
                                case "success":
                                case "warning":
                                    run.passed(testItem!, duration);
                                    if (data.message) {
                                        run.appendOutput(data.message, undefined, testItem);
                                    }
                                    break;
                                case "failure":
                                    run.failed(
                                        testItem!,
                                        new vscode.TestMessage(data.message!),
                                        duration
                                    );
                                    break;
                                case "skip":
                                    run.skipped(testItem!);
                                    if (data.message) {
                                        run.appendOutput(data.message, undefined, testItem);
                                    }
                                    break;
                                case "error":
                                    run.errored(
                                        testItem!,
                                        new vscode.TestMessage(data.message!),
                                        duration
                                    );
                                    break;
                            }
                        }
                        break;
                }
            });
        childProcess.once("exit", () => {
            stdout += childProcess.stderr.read();
            if (stdout.includes("Execution halted")) {
                reject(Error(stdout));
            }
            resolve(stdout);
        });
        childProcess.once("error", (err) => {
            reject(err);
        });
    });
}

function findTestRecursively(testIdToFind: string, testToSearch: vscode.TestItem) {
    let testFound: vscode.TestItem | undefined = undefined;
    testToSearch.children.forEach((childTest: vscode.TestItem) => {
        if (testFound === undefined) {
            testFound =
                testIdToFind == childTest.id
                    ? childTest
                    : findTestRecursively(testIdToFind, childTest);
        }
    });
    return testFound;
}


async function runSingleTest(
    testingTools: TestingTools,
    run: vscode.TestRun,
    test: vscode.TestItem
) {
    return runSingleTestFile(testingTools, run, test, true)
        .catch(async (err) => {
            run.appendOutput(err);
            throw err;
        })
        .then(async (value) => {
            run.appendOutput(value);
            return value;
        });
}

async function getRscriptCommand(testingTools: TestingTools) {
    let config = vscode.workspace.getConfiguration("RTestAdapter");
    let configPath: string | undefined = config.get("RscriptPath");
    if (configPath !== undefined && configPath !== null) {
        if ((<string>configPath).length > 0 && fs.existsSync(configPath)) {
            testingTools.log.info(`Using Rscript in the configuration: ${configPath}`);
            return Promise.resolve(`"${configPath}"`);
        } else {
            testingTools.log.warn(
                `Rscript path given in the configuration ${configPath} is invalid. ` +
                `Falling back to defaults.`
            );
        }
    }
    if (RscriptPath !== undefined) {
        testingTools.log.info(`Using previously detected Rscript path: ${RscriptPath}`);
        return Promise.resolve(`"${RscriptPath}"`);
    }
    RscriptPath = await lookpath("Rscript");
    if (RscriptPath !== undefined) {
        testingTools.log.info(`Found Rscript in PATH: ${RscriptPath}`);
        return Promise.resolve(`"${RscriptPath}"`);
    }
    if (process.platform != "win32") {
        let candidates = ["/usr/bin", "/usr/local/bin"];
        for (const candidate of candidates) {
            let possibleRscriptPath = path.join(candidate, "Rscript");
            if (fs.existsSync(possibleRscriptPath)) {
                testingTools.log.info(
                    `found Rscript among candidate paths: ${possibleRscriptPath}`
                );
                RscriptPath = possibleRscriptPath;
                return Promise.resolve(`"${RscriptPath}"`);
            }
        }
    } else {
        try {
            const key = new winreg({
                hive: winreg.HKLM,
                key: "\\Software\\R-Core\\R",
            });
            const item: winreg.RegistryItem = await new Promise((resolve, reject) =>
                key.get("InstallPath", (err, result) => (err ? reject(err) : resolve(result)))
            );

            const rhome = item.value;

            let possibleRscriptPath = rhome + "\\bin\\Rscript.exe";
            if (fs.existsSync(possibleRscriptPath)) {
                testingTools.log.info(`found Rscript in registry: ${possibleRscriptPath}`);
                RscriptPath = possibleRscriptPath;
                return Promise.resolve(`"${RscriptPath}"`);
            }
        } catch (e) { }
    }
    throw Error("Rscript could not be found in PATH, cannot run the tests.");
}

async function getDevtoolsVersion(
    testingTools: TestingTools,
    RscriptCommand: string
): Promise<{ major: number; minor: number; patch: number }> {
    return new Promise(async (resolve, reject) => {
        let childProcess = spawn(
            `${RscriptCommand} -e "suppressMessages(library('devtools'));` +
            `packageVersion('devtools')"`,
            {
                shell: true,
            }
        );
        let stdout = "";
        childProcess.once("exit", () => {
            stdout += childProcess.stdout.read() + "\n" + childProcess.stderr.read();
            let version = stdout.match(/(\d*)\.(\d*)\.(\d*)/i);
            if (version !== null) {
                testingTools.log.info(`devtools version: ${version[0]}`);
                const major = parseInt(version[1]);
                const minor = parseInt(version[2]);
                const patch = parseInt(version[3]);
                resolve({ major, minor, patch });
            } else {
                reject(Error("devtools version could not be detected. Output:\n" + stdout));
            }
        });
        childProcess.once("error", (err) => {
            reject(err);
        });
    });
}

export default runTest;

const _unittestable = {
    getRscriptCommand,
    getDevtoolsVersion,
};
export { _unittestable };
