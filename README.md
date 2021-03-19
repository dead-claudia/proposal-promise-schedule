# A proposal to add promise task scheduling

- [Problem](#problem)
- [Solution](#solution)
- [Proposed polyfill](#proposed-polyfill)

## Problem

I find myself quite often faced with one of the following idioms:

```js
// Idiom 1: `Promise.all(list.map(func))` (wasteful, sometimes slow)
await Promise.all(collection.map(async item => {
    await doSomething(item)
    if (hasSomeWeirdAspectToIt(item)) {
        await doSomethingElse(item)
    }
}))

// Idiom 2: building an array of promises (wasteful, bad)
let queue = []

for (const item of collection) {
    queue.push(doSomething(item))
    if (hasSomeWeirdAspectToIt(item)) {
        queue.push(doSomethingElse(item))
    }
}

await Promise.all(queue)

// Idiom 2: building an array of task functions (wasteful)
let queue = []

for (const item of collection) {
    queue.push(async () => doSomething(item))
    if (hasSomeWeirdAspectToIt(item)) {
        queue.push(async () => doSomethingElse(item))
    }
}

await Promise.all(queue.map(task => task()))

// Idiom 3: using an `open` counter and the `Promise` constructor
await new Promise((resolve, reject) => {
    let open = 1

    async function enqueue(task) {
        open++
        try {
            await task()
        } catch (e) {
            open = 0
            reject(e)
            return
        }
        open--
        if (open === 0) resolve()
    }

    for (const item of collection) {
        enqueue(async () => doSomething(item))
        if (hasSomeWeirdAspectToIt(item)) {
            enqueue(async () => doSomethingElse(item))
        }
    }

    open--
    if (open === 0) resolve()
})

// Idiom 4: using an `open` counter, a task queue, and the `Promise` constructor
await new Promise((resolve, reject) => {
    const concurrencyLimit = 10

    let queue = []
    let open = 1

    async function enqueue(task) {
        if (open === concurrencyLimit) {
            queue.push(task)
            return
        }
        open++
        do {
            try {
                await task()
            } catch (e) {
                open = 0
                reject(e)
                return
            }
            task = queue.shift()
        } while (task != null)
        open--
        if (open === 0) resolve()
    }

    for (const item of collection) {
        enqueue(async () => doSomething(item))
        if (hasSomeWeirdAspectToIt(item)) {
            enqueue(async () => doSomethingElse(item))
        }
    }

    open--
    if (open === 0) resolve()
})
```

There's several major problems with this:

1. Concurrency is hard.
2. It's boilerplatey and very error-prone.
3. Either you pick large amounts of complexity or large amounts of wasted memory.
4. Need to catch sync errors? Things just suddenly got a little more complex. Don't need to catch sync errors? Give it a few days for something to throw, and yes, you will.
5. Do you have a potentially very large or unbounded sequence and you want to process it concurrently? Congratulations, `Promise.all` will never work in your favor and you will have to use the long form with an explicit `open` counter to not run out of memory.
6. Do you need to limit concurrency to ensure throughput or limit memory usage? You're forced to either do the longest form or manually iterate the collection with occasional `await readyForNextValue()` calls in the loop, as `Promise.all` doesn't offer anything to let you manage concurrency.
7. What if you try to schedule a task after it resolves? Fun fact: I've been bit by that specific scenario, and had to introduce a locking mechanism for it. But I don't expect people to realize this and account for it until things go wrong and either they receive a bug report or notice a strange pattern in their logs (assuming they even have error reporting set up).

And yes, I've used all 4 idioms in the wild numerous times, especially at work. And every single time it's made the whole thing mildly intricate to write. Also, consider that [Bluebird's `Promise.map` has had a `concurrency` option since before ES6](http://bluebirdjs.com/docs/api/promise.map.html). (I *believe* it may even have been proposed previously, though I'm not 100% sure where.)

## Solution

I've got a very simple yet effective solution for this:

```js
result = await Promise.scheduleAndRun(
    async schedule => result,
    opts = {maxConcurrency: Infinity}
)
```

> That name is very bikesheddable and obviously somewhat ugly. But we resolve that later, pun intended.

Here's the TS definitions for that for a quick overview:

```ts
interface PromiseConstructor {
    scheduleAndRun<TaskResult>(
        // Note: this outer function counts against the concurrency limit, and
        // for statistical purposes counts as a task remaining. However, it does
        // *not* result in invoking `onResolved` or `onRejected` - instead, it
        // impacts whether the outer promise resolves or rejects.
        init: (
            // Returns `true` if the function was scheduled immediately, `false`
            // otherwise.
            // This can be called even during child task execution, but locks as
            // soon as the last remaining task result resolves.
            schedule: (task: () => TaskResult | PromiseLike<TaskResult>) => boolean
        ) => TaskResult | PromiseLike<TaskResult>,
        options: {
            // Set the max concurrency. If `Infinity`, no concurrency limit
            // exists, and if less than 1, it throws a `RangeError`.
            maxConcurrency?: number;
            // Called once a task resolves. The default behavior is to ignore
            // the result.
            onResolved?(value: TaskResult): void;
            // Called once a task rejects. The default behavior is to re-throw,
            // and caught errors are aggregated with any applicable `init` error
            // into an `AggregateError` that's eventually returned.
            onRejected?(error: Error): void;
        }
    ): Promise<InitResult>
}
```

> In case you're wondering what that `onResolved` and `onRejected` are for, I have a helper function in the wild thqt uses exactly that to create a concurrency-controlled `Promise.all`.

In practice, use might look like this:

```js
// The above example, sync and 100% parallel
await Promise.scheduleAndRun(async schedule => {
    for (const item of collection) {
        schedule(() => doSomething(item))
        if (hasSomeWeirdAspectToIt(item)) {
            schedule(() => doSomethingElse(item))
        }
    }
})

// A simple concurrency-controlled and observable `Promise.all` based on code at
// work. (You can do things like update the UI on promise fulfillment and
// rejection fairly straightforwardly using this.)
async function runAndCollect(init, opts) {
    const results = []

    await Promise.scheduleAndRun(init, {
        ...opts,
        onResolved(result) {
            results.push(result)
            if (opts && opts.onResolved) opts.onResolved(result)
        },
        onRejected(error) {
            if (opts && opts.onRejected) opts.onRejected(error)
            throw error
        },
    })

    return results
}

const results = await runAndCollect(schedule => {
    for (const item of list) {
        schedule(() => callApi({id: item.id, ...}))
    }
}, {
    maxConcurrency: 10,
    onResolved() { advanceProgressBar() },
})

completeProgressBar()
```

## Proposed polyfill

Here's a possible polyfill of what I'm proposing. Only a very rudimentary attempt is made to ensure performance, and the spec text would roughly equate to this.

> As you can see, this is very non-trivial and somewhat involved, despite the relative simplicity of the API. I would not expect most people that aren't at least passingly familiar with computer science to be able to come up with this very quickly.
>
> If you want a more optimized polyfill suitable to try out in production, take a look at `polyfill.js` here in the project root. Of course, it's a bit more involved, but 1. performance is neither simple nor easy and 2. it's also geared towards informing engine implementation.

```js
if (!Promise.scheduleAndRun) {
    Promise.scheduleAndRun = (initialize, opts) => {
        const maxConcurrencyOpt = opts != null ? opts.maxConcurrency : null
        const maxConcurrency = maxConcurrencyOpt != null
            ? Math.floor(maxConcurrencyOpt)
            : Infinity

        if (Number.isNaN(maxConcurrency) || maxConcurrency < 1) {
            throw new RangeError("Concurrency must be at least 1")
        }

        return new Promise((resolve, reject) => {
            let errors = []
            let active = 1
            let queue = []
            let initalizerResult

            function handleReaction(hookName, value) {
                if (opts == null) return false
                try {
                    const hook = opts[hookName]
                    if (hook == null) return false
                    hook.call(opts, value)
                } catch (e) {
                    errors.push(value)
                }
                return true
            }

            function handleResult(type, promise) {
                promise.then(
                    value => {
                        if (type === "initial") {
                            initalizerResult = value
                        }
                        handleReaction("onResolved", value)
                        settleTask()
                    },
                    value => {
                        if (!handleReaction("onRejected", value)) {
                            errors.push(e)
                        }
                        settleTask()
                    }
                )
            }

            function settleTask() {
                const next = queue.shift()
                if (next != null) {
                    handleResult("scheduled",
                        Promise.resolve().then(() => next())
                    )
                } else {
                    active--
                    if (active === 0) {
                        if (errors.length) {
                            reject(new AggregateError(errors))
                        } else {
                            resolve(initalizerResult)
                        }
                        errors = queue = resolve = reject = undefined
                    }
                }
            }

            handleResult("initial",
                new Promise(resolve => {
                    if (active === 0) return false
                    if (active < maxConcurrency) {
                        active++
                        invokeTask("scheduled", task)
                        return true
                    } else {
                        queue.push(task)
                        return false
                    }
                })
            )
        })
    }
}
```