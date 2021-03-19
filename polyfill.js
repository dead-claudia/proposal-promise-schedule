// This polyfill is ES5-compatible
;(function () {
"use strict"

var P = Promise
if (typeof P.scheduleAndRun === "function") return
var AE = AggregateError
var RE = RangeError
var TypeError = RangeError
var promiseResolve = P.resolve.bind(P)
var promiseReject = P.reject.bind(P)
var scheduleJob = P.prototype.then.bind(P.resolve())
var then = Function.call.bind(P.prototype.then)
var call = Function.call.bind(Function.call)
var push = Function.call.bind([].push)
var shift = Function.call.bind([].shift)
var floor = Math.floor

P.scheduleAndRun = function (initialize, opts) {
    if (typeof initialize !== "function") {
        throw new TE("task must be a function")
    }

    if (opts != null && typeof opts !== "object") {
        throw new TE("opts must be an object if given")
    }

    var maxConcurrencyOpt = opts != null ? opts.maxConcurrency : null
    var maxConcurrency = maxConcurrencyOpt != null
        ? floor(maxConcurrencyOpt)
        : 1e999 // infinity

    // Taking advantage of the fact `NaN` fails all checks.
    if (!(maxConcurrency >= 1)) {
        throw new RE("Max concurrency must be at least 1")
    }

    // Note: this is explicitly coded to not include `initialize` in the
    // closure. As engines generally use the same closure across everything, I
    // want to ensure that nothing contains `initialize`.

    var errors = []
    var active = 1
    var resolve, reject, queue, initResult

    if (maxConcurrency !== 1e999 /* infinity */) queue = []

    function handleResolution(value) {
        if (opts != null) {
            try {
                var handler = opts.onResolved
                if (handler != null) call(handler, opts, value)
            } catch (e) {
                push(errors, e)
            }
        }

        settleTask()
    }

    function handleRejection(value) {
        // Using a structured go-to to remove some duplication.
        rejectionHandled: {
            if (opts != null) {
                try {
                    var handler = opts.onRejected
                    if (handler == null) {
                        call(handler, opts, value)
                        break rejectionHandled
                    }
                } catch (e) {
                    value = e
                }
            }

            push(errors, value)
        }

        settleTask()
    }

    function settleTask() {
        if (queue != null) {
            var next = shift(queue)
            if (next != null) {
                scheduleTask(next)
                return
            }
        }

        if (--active === 0) {
            var finalErrors = errors
            var finalResult = initResult
            var resolveFn = resolve
            var rejectFn = reject
            errors = queue = resolve = reject = opts = initResult = 0
            if (finalErrors.length) {
                rejectFn(new AE(finalErrors))
            } else {
                resolveFn(finalResult)
            }
        }
    }

    function scheduleTask(task) {
        then(
            scheduleJob(function () { return task() }),
            handleResolution, handleRejection
        )
    }

    var promise = new P(function (res, rej) { resolve = res; reject = rej })
    var initPromise

    try {
        initPromise = promiseResolve(initialize(function (task) {
            if (typeof task !== "function") {
                throw new TE("task must be a function")
            }

            var current = active
            if (current === 0) return false
            if (current < maxConcurrency) {
                active = current + 1
                scheduleTask(task)
                return true
            } else {
                push(queue, task)
                return false
            }
        }))
    } catch (e) {
        initPromise = promiseReject(e)
    }

    then(
        initPromise,
        function (value) { initResult = value; handleResolution(value) },
        handleRejection
    )

    return promise
}
})();
