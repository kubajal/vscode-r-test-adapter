import * as vscode from "vscode";
import { Log } from "vscode-test-adapter-util";

export enum ItemType {
    File = "file",
    TestCase = "test",
}

export enum ItemFramework {
    Testthat = "testthat",
}

export interface TestingTools {
    controller: vscode.TestController;
    log: Log;
    testItemData: WeakMap<
        vscode.TestItem,
        {
            itemType: ItemType;
            itemFramework: ItemFramework;
        }
    >;
    tempFilePaths: String[];
}

export interface TestParser {
    (testingTools: TestingTools, file: vscode.TestItem): Promise<void>;
}

export interface TestRunner {
    (testingTools: TestingTools, run: vscode.TestRun, test: vscode.TestItem,
        entryPointStrategy: (test: vscode.TestItem) => string): Promise<string>;
}
