// This polyfill is ES5-compatible
;(function () {
"use strict"

var P = Promise
if (typeof P.scheduleAndRun === "function") return
var AE = AggregateError
var RE = RangeError
var TE = TypeError
var promiseResolve = P.resolve.bind(P)
var promiseReject = P.reject.bind(P)
var scheduleJob = P.prototype.then.bind(P.resolve())
var then = Function.call.bind(P.prototype.then)
var call = Function.call.bind(Function.call)
var floor = Math.floor
var setPrototypeOf = Object.setPrototypeOf

// Avoid making sets observable via things like
// `Object.defineProperty(Array.prototype, 0, {set(v) { ... }})`.
function safeArray(n) {
    var array = Object.create(null)
    array[0] = void 0
    return array
}

function promiseTry(func) {
    return new P(function (resolve) {
        resolve(func())
    })
}

var safeArrayPrototype = Object.create(null)

safeArrayPrototype[Symbol.iterator] = [].values

safeArrayPrototype.fill = [].fill || function (value, from, to) {
    while (from < to) this[from++] = value
}

safeArrayPrototype.copyWithin = [].copyWithin || function (target, from, to) {
    while (from < to) this[target++] = this[from++]
}

safeArrayPrototype.push = [].push

function safeArray() {
    var result = []
    // Fix the prototype so it doesn't fire setters.
    setPrototypeOf(result, safeArrayPrototype)
    return result
}

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

    var errors = safeArray()
    var active = 1
    // The queue is implemented as a growable circular buffer for efficiency.
    var queueHead = 0
    var queueTail = 0
    var queue = safeArray()
    var resolve, reject, queue, initResult

    function handleResolution() {
        if (opts != null) {
            try {
                var handler = opts.onResolved
                if (handler != null) call(handler, opts)
            } catch (e) {
                errors.push(e)
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

            errors.push(value)
        }

        settleTask()
    }

    function settleTask() {
        var head = queueHead

        if (head !== queueTail) {
            var queueRef = queue
            var mask = queueRef.length - 1
            var next = queueRef[head]
            var resolve = queueRef[(head + 1) & mask]
            var reject = queueRef[(head + 2) & mask]
            queueHead = (head + 3) & mask

            var promise = promiseTry(next)

            resolve(promise)

            then(promise, handleResolution, handleRejection)
            return
        }

        if (--active === 0) {
            var finalErrors = errors
            var finalResult = initResult
            var resolveFn = resolve
            var rejectFn = reject
            queueHead = queueTail =
            errors = queue = resolve = reject = opts = initResult = 0
            if (finalErrors.length) {
                rejectFn(new AE(finalErrors))
            } else {
                resolveFn(finalResult)
            }
        }
    }

    // This explicitly needs to be array-like.
    errors.length = 0

    var promise = new P(function (res, rej) {
        resolve = res
        reject = rej
    })

    var initPromise

    try {
        initPromise = promiseResolve(initialize(function (task) {
            if (typeof task !== "function") {
                throw new TE("task must be a function")
            }

            var current = active
            if (current === 0) throw new Error("Scheduler locked!")

            var resolve, reject
            var promise = new P(function (res, rej) {
                resolve = res
                reject = rej
            })

            var queueRef = queue
            var length = queueRef.length
            var mask = length - 1
            var head = queueHead
            var tail = queueTail

            // If we have less than 3 available entries, grow the buffer
            if (((tail - head) & mask) < 3) {
                // Power-of-two length makes for an easier modulo.
                queueRef.fill(void 0,
                    length,
                    queueRef.length = length === 0 ? 16 : length << 1
                )
                // If the tail wrapped around, move it back such that it's no longer
                // wrapped around.
                if (tail < head) {
                    queueRef.copyWithin(length, 0, tail)
                    queueRef.fill(void 0, 0, tail)
                    tail += length
                }
            }

            queueRef[tail] = task
            queueRef[(tail + 1) & mask] = resolve
            queueRef[(tail + 2) & mask] = reject
            queueTail = (tail + 3) & mask

            if (current < maxConcurrency) {
                active = current + 1
                scheduleTask(settleTask)
            }

            return promise
        }))
    } catch (e) {
        initPromise = promiseReject(e)
    }

    then(
        initPromise,
        function (value) {
            initResult = value
            handleResolution()
        },
        handleRejection
    )

    return promise
}
})();
