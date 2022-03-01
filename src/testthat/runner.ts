import { Uri, workspace } from "vscode";
import * as util from "util";
import * as path from "path";
import * as winreg from "winreg";
import * as fs from "fs";
import * as tmp from "tmp-promise";
import { spawn } from "child_process";
import * as vscode from "vscode";
import * as split2 from "split2";
import { TestEvent, TestInfo, TestSuiteInfo } from "vscode-test-adapter-api";
import { encodeNodeId, findTests } from "./parser";
import { appendFile as _appendFile } from "fs";
import { TestthatAdapter } from "./adapter";
import { lookpath } from "lookpath";
import { TestResult } from "./reporter";

const appendFile = util.promisify(_appendFile);
const testReporterPath = path
    .join(__dirname, "..", "..", "..", "src", "testthat", "reporter")
    .replace(/\\/g, "/");
const resultMap: Record<string, string> = {
    success: "passed",
    failure: "failed",
    error: "errored",
    skip: "skipped",
    warning: "passed",
};
let RscriptPath: string | undefined;

export async function runSingleTestFile(
    adapter: TestthatAdapter,
    filePath: string,
    node: TestSuiteInfo | TestInfo,
    testRunId: string
): Promise<string> {
    let cleanFilePath = filePath.replace(/\\/g, "/");
    let projectDirMatch = cleanFilePath.match(/(.+?)\/tests\/testthat.+?/i);
    let RscriptCommand = await getRscriptCommand(adapter);
    let { major, minor, patch } = await getDevtoolsVersion(RscriptCommand, adapter);
    if (major < 2 || (major == 2 && minor < 3) || (major == 2 && minor == 3 && patch < 2)) {
        return Promise.reject(
            Error(`Devtools version too old. RTestAdapter requires devtools>=2.3.2
            to be installed in the Rscript environment`)
        );
    }
    let devtoolsMethod = major == 2 && minor < 4 ? "test_file" : "test_active_file";
    let devtoolsCall = `devtools::load_all('${testReporterPath}');devtools::${devtoolsMethod}('${cleanFilePath}',reporter=VSCodeReporter)`;
    let command = `${RscriptCommand} -e "${devtoolsCall}"`;
    let cwd = projectDirMatch
        ? projectDirMatch[1]
        : vscode.workspace.workspaceFolders![0].uri.fsPath;
    return new Promise(async (resolve, reject) => {
        let childProcess = spawn(command, { cwd, shell: true });
        let stdout = "";
        adapter.childProcess = childProcess;
        childProcess.stdout!.pipe(split2(JSON.parse)).on("data", (data: TestResult) => {
            stdout += JSON.stringify(data);
            if (data.type === undefined) return;
            if (
                data.type === "add_result" &&
                data.result !== undefined &&
                data.test !== undefined
            ) {
                let state = resultMap[data.result];
                adapter.testStatesEmitter.fire(<TestEvent>{
                    type: "test",
                    test: node.type === "test" ? node.id : encodeNodeId(node.file!, data.test),
                    state: state,
                    message: data.message ? data.message : undefined,
                    testRunId,
                });
            }
            if (data.type === "start_test" && data.test !== undefined) {
                adapter.testStatesEmitter.fire(<TestEvent>{
                    type: "test",
                    test: node.type === "test" ? node.id : encodeNodeId(node.file!, data.test),
                    state: "running",
                    testRunId,
                });
            }
        });
        childProcess.once("exit", () => {
            adapter.childProcess = undefined;
            stdout += childProcess.stderr.read();
            if (stdout.includes("Execution halted")) {
                reject(Error(stdout));
            }
            resolve(stdout);
        });
        childProcess.once("error", (err) => {
            adapter.childProcess = undefined;
            reject(err);
        });
    });
}

export async function runDescribeTestSuite(
    adapter: TestthatAdapter,
    suite: TestSuiteInfo,
    testRunId: string
) {
    let documentUri = Uri.file(suite.file!);
    let document = await workspace.openTextDocument(documentUri);
    let source = document.getText();
    let allTests = await findTests(documentUri);

    for (const parsedTest of allTests) {
        const { testSuperLabel, testStartIndex, testEndIndex, testSuperEndIndex } = parsedTest;
        if (testEndIndex >= source.length) break;
        if (testSuperLabel != suite.label) {
            source =
                source.slice(0, testStartIndex) +
                " ".repeat(testEndIndex - testStartIndex) +
                source.slice(testEndIndex!);
        } else {
            source = source.slice(0, testSuperEndIndex!);
            break;
        }
    }

    let tmpFileName = `test-${testRunId}.R`;
    let tmpFilePath = path.normalize(path.join(path.dirname(suite.file!), tmpFileName));
    adapter.tempFilePaths.add(tmpFilePath); // Do not clean up tempFilePaths, not possible to get around the race condition
    // cleanup is not guaranteed to unlink the file immediately
    let tmpFileResult = await tmp.file({
        name: tmpFileName,
        tmpdir: path.dirname(suite.file!),
    });
    await appendFile(tmpFilePath, source);
    return runSingleTestFile(adapter, tmpFilePath, suite, testRunId)
        .catch(async (err) => {
            await tmpFileResult.cleanup();
            throw err;
        })
        .then(async (value) => {
            await tmpFileResult.cleanup();
            return value;
        });
}

export async function runSingleTest(adapter: TestthatAdapter, test: TestInfo, testRunId: string) {
    let documentUri = Uri.file(test.file!);
    let document = await workspace.openTextDocument(documentUri);
    let source = document.getText();
    let allTests = await findTests(documentUri);

    for (const parsedTest of allTests) {
        const { testStartIndex, testEndIndex, testSuperEndIndex, testLabel } = parsedTest;
        if (testEndIndex >= source.length) break;
        if (testLabel != test.label) {
            source =
                source.slice(0, testStartIndex) +
                " ".repeat(testEndIndex - testStartIndex) +
                source.slice(testEndIndex!);
        } else {
            let lastIndex = testSuperEndIndex ? testSuperEndIndex : testEndIndex;
            source = source.slice(0, lastIndex);
        }
    }

    let tmpFileName = `test-${testRunId}.R`;
    let tmpFilePath = path.normalize(path.join(path.dirname(test.file!), tmpFileName));
    adapter.tempFilePaths.add(tmpFilePath); // Do not clean up tempFilePaths, not possible to get around the race condition
    // cleanup is not guaranteed to unlink the file immediately
    let tmpFileResult = await tmp.file({
        name: tmpFileName,
        tmpdir: path.dirname(test.file!),
    });
    await appendFile(tmpFilePath, source);
    return runSingleTestFile(adapter, tmpFilePath, test, testRunId)
        .catch(async (err) => {
            await tmpFileResult.cleanup();
            throw err;
        })
        .then(async (value) => {
            await tmpFileResult.cleanup();
            return value;
        });
}

async function getRscriptCommand(adapter: TestthatAdapter) {
    let config = vscode.workspace.getConfiguration("RTestAdapter");
    let configPath: string | undefined = config.get("RscriptPath");
    if (configPath !== undefined && configPath !== null) {
        if ((<string>configPath).length > 0 && fs.existsSync(configPath)) {
            adapter.log.info(`Using Rscript in the configuration: ${configPath}`);
            return Promise.resolve(`"${configPath}"`);
        } else {
            adapter.log.warn(
                `Rscript path given in the configuration ${configPath} is invalid. Falling back to defaults.`
            );
        }
    }
    if (RscriptPath !== undefined) {
        adapter.log.info(`Using previously detected Rscript path: ${RscriptPath}`);
        return Promise.resolve(`"${RscriptPath}"`);
    }
    RscriptPath = await lookpath("Rscript");
    if (RscriptPath !== undefined) {
        adapter.log.info(`Found Rscript in PATH: ${RscriptPath}`);
        return Promise.resolve(`"${RscriptPath}"`);
    }
    if (process.platform != "win32") {
        let candidates = ["/usr/bin", "/usr/local/bin"];
        for (const candidate of candidates) {
            let possibleRscriptPath = path.join(candidate, "Rscript");
            if (fs.existsSync(possibleRscriptPath)) {
                adapter.log.info(`found Rscript among candidate paths: ${possibleRscriptPath}`);
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
                adapter.log.info(`found Rscript in registry: ${possibleRscriptPath}`);
                RscriptPath = possibleRscriptPath;
                return Promise.resolve(`"${RscriptPath}"`);
            }
        } catch (e) {}
    }
    throw Error("Rscript could not be found in PATH, cannot run the tests.");
}

async function getDevtoolsVersion(
    RscriptCommand: string,
    adapter: TestthatAdapter
): Promise<{ major: number; minor: number; patch: number }> {
    return new Promise(async (resolve, reject) => {
        let childProcess = spawn(
            `${RscriptCommand} -e "suppressMessages(library('devtools'));packageVersion('devtools')"`,
            {
                shell: true,
            }
        );
        let stdout = "";
        childProcess.once("exit", () => {
            stdout += childProcess.stdout.read() + "\n" + childProcess.stderr.read();
            let version = stdout.match(/(\d*)\.(\d*)\.(\d*)/i);
            if (version !== null) {
                adapter.log.info(`devtools version: ${version[0]}`);
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

export const _unittestable = {
    getDevtoolsVersion,
    getRscriptCommand,
};
