const { join } = require("path");
const { existsSync, mkdirSync, rmSync, readdirSync } = require("fs");
const { fork } = require("child_process");


const commonSubstring = {
    cross: "\x1b[31m✗",
    tick: "\x1b[32m✓"
};
for(const substring in commonSubstring) {
    commonSubstring[substring] += "\x1b[0m";
}

const testCounter = {
    failed: 0,
    succeeded: 0
};

const testRange = {
    callQueue: [],
    stackSize: 0
};

const exitTimeoutLength = 3000;
let exitTimeout = null;
let timeoutEnabled = false;

const tmpDirPath = join(process.cwd(), "./test/.tmp/");

const envProcesses = [];


!existsSync(tmpDirPath)
&& mkdirSync(tmpDirPath);


process.on("uncaughtException", err => {
    console.error(err);

    process.exit(1);
});

process.on("exit", code => {
    try {
        envProcesses.forEach(process => process.kill());
    } catch { /**/ }

    if(code === -1) {
        return;
    }

    const resultIndicatorSubstring = "\x1b[2m➞  \x1b[0m";

    if(code !== 0) {
        console.log(`\n${resultIndicatorSubstring}${commonSubstring.cross} Test run has tertminated due to runtime error.\n`);

        return code;
    }

    if((testCounter.succeeded + testCounter.failed) === 0) {
        return;
    }

    const ratioSubstring = `(${testCounter.succeeded}/${testCounter.failed + testCounter.succeeded})`;

    if(testCounter.failed > 0) {
        console.error(`${resultIndicatorSubstring}${commonSubstring.cross} Test run \x1b[5m\x1b[31mfailed\x1b[0m ${ratioSubstring}.\n`);

        return 1;
    }

    console.log(`${resultIndicatorSubstring}${commonSubstring.tick} Test run \x1b[5m\x1b[32msucceeded\x1b[0m ${ratioSubstring}.\n`);
});

process.on("exit", cleanUp);
process.on("SIGINT", cleanUp);
process.on("SIGTERM", cleanUp);
process.on("uncaughtException", cleanUp);
process.on("unhandledRejection", cleanUp);


process.argv.push("--path");
process.argv.push("./test/.tmp");  // Set working directory arguments


// TODO: Mark app log / separate


function runEnvironmentalScript(name, env) {
    const path = join(process.cwd(), "./test/", `${name.toLowerCase()}.${env}.js`);

    if(!existsSync(path)) {
        return null;
    }

    console.log(`\x1b[2m+ ENV \x1b[1m${env.toUpperCase()}\x1b[0m\n`);

    const child = fork(path, [], {
        stdio: "pipe"
    }); // TODO: Mode; [ "--dev" ] ?

    child.stdout.on("data", data => {
        console.group();
        console.log(`\x1b[2m--- ENV log ---`);
        console.log(String(data));
        console.groupEnd("\x1b[0m");
    });

    child.stderr.on("data", data => {
        console.group();
        console.log(`\x1b[2m--- ENV \x1b[31merror\x1b[30m ---`);
        console.error(String(data));
        console.groupEnd("\x1b[0m");
    });

    return child;
}

function cleanUp() {
    existsSync(tmpDirPath)
    && rmSync(tmpDirPath, {
        recursive: true
    });

    process.exit(-1);
}

function logBadge(message, colorRgb, suffix) {
    const fgDirective = (colorRgb.reduce((p, c) => p + c, 0) < ((3 * 256) / 1.25))
    ? "\x1b[38;2;255;255;255m" : "";

    console.log(`${fgDirective}\x1b[1m\x1b[48;2;${colorRgb[0]};${colorRgb[1]};${colorRgb[2]}m ${message} \x1b[0m${suffix ? ` ${suffix}` : ""}\n`);
}

function updateExitTimeout() {
    clearTimeout(exitTimeout);

    if(!timeoutEnabled) {
        return;
    }
    
    exitTimeout = setTimeout(_ => {
        (testRange.stackSize === 0)
        && process.exit(0);

        throw new EvalError("Test case has timed out");
    }, exitTimeoutLength);
}

function minAssert(caption, specificAssert, actualExpression, expected) {   // TODO: Call lists?
    testRange.stackSize++;

    let specificResult;

    const catchError = err => {
        if(specificAssert) {
            throw err;
        }

        specificResult = {
            hasSucceeded: false,
            actual: `\x1b[31m${err.stack || err.name}\x1b[0m`,
            expected: "No error"
        }
    };

    const complete = _ => {
        const hasSucceeded = (specificResult !== undefined)
        ? (specificResult.hasSucceeded ?? specificResult)
        : true;
        
        logBadge(`Case ${(testCounter.failed + testCounter.succeeded + 1)}`, [ 255, 249, 194 ], `${commonSubstring[hasSucceeded ? "tick" : "cross"]} \x1b[2m${caption}\x1b[0m`);

        testCounter[hasSucceeded ? "succeeded" : "failed"]++;

        if(!hasSucceeded) {
            console.group();
            
            const logValue = (caption, value) => {
                console.log(`\x1b[48:5:253m\x1b[38;2;255;255;255m ${caption} \x1b[0m\n`);
                console.log(value);
                console.log("");
            };
            
            logValue("Expected", specificResult.expected || expected);
            logValue("Actual", specificResult.actual || actualExpression);
            
            console.groupEnd();
        }
        
        if(--testRange.stackSize === 0 && testRange.callQueue.length) {
            run.apply(null, testRange.callQueue.shift());
        } else {
            updateExitTimeout();
        }
    };

    try {
        actualExpression = (actualExpression instanceof Function)
        ? actualExpression()
        : actualExpression;
    } catch(err) {
        catchError(err);

        complete();

        return;
    }
    
    specificResult = specificAssert
    ? specificAssert(actualExpression, expected)
    : actualExpression;
    
    (!(specificResult instanceof Promise)
    ? new Promise(r => r(specificResult))
    : specificResult)
    .then(result => {
        specificResult = result;
    })
    .catch(catchError)
    .finally(complete);
}


global.assertSuccess = function(caption, actualExpression) {
    minAssert(caption, null, actualExpression, null);
};


module.exports.run = async function(path, caption, captionColorRgb, specificAssert, useTimeout = false) {
    timeoutEnabled = useTimeout;
    
    const envProcess = runEnvironmentalScript(caption, "setup");
    if(envProcess) {
        envProcesses.push(envProcess);

        const envTimeout = setTimeout(_ => {
            throw new RangeError(`Environmental setup has timed out '${caption.toLowerCase()}.setup.js'`);
        }, 10000);

        await new Promise(resolve => {
            envProcess.on("message", code => {
                if(code !== 0) {
                    reject(new EvalError(`Environmental setup terminated with error code ${code} '${caption}.setup.js'`));
                }

                resolve();
            });
        });

        clearTimeout(envTimeout);
    }

    process.on("exit", _ => {
        runEnvironmentalScript(caption, "cleanup");
    });

    updateExitTimeout();

    if(testRange.stackSize > 0) {
        testRange.callQueue.push([ path, caption, captionColorRgb, specificAssert ]);
        
        return;
    }
    
    logBadge(`${caption.toUpperCase()} Tests`, captionColorRgb);
    
    global.assert = (caption, actualExpression, expected) => { // =: assert equals
        minAssert(caption, specificAssert, actualExpression, expected);
    };
    
    path = join(process.cwd(), "./test/", path);
    readdirSync(path, {
        withFileTypes: true
    })
    .filter(dirent => dirent.isFile())
    .filter(dirent => /\.test\.js$/.test(dirent.name))
    .forEach(dirent => {
        try {
            require(join(path, dirent.name));
        } catch(err) {
            console.error(err);

            process.exit(1);
        }
    });
};