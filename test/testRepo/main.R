
.vsc.load_all(".")
.vsc.load_all("/home/kubajal/development/testthat")
.vsc.load_all("/home/kubajal/development/vscode-r-test-adapter/src/testthat/reporter")
the$selected_description <- c("^Email address$", "got EMAIL env var")
testthat::with_reporter(VSCodeReporter, {
    .vsc.debugSource("/home/kubajal/development/vscode-r-test-adapter/test/testRepo/tests/testthat/test-email.R")
})
