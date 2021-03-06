# Composable promise task scheduling

- [Problem](#problem)
- [Solution](#solution)
- [Proposed polyfill](#proposed-polyfill)
- [Follow-on: Task options](#follow-on-task-options)

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

And yes, I've used all 4 idioms in the wild numerous times, especially at work, and I've even written out a function for that idiom 4 multiple times already. And every single time it's made the whole thing mildly intricate to write. Also, consider that:

- [Bluebird's `Promise.map` has had a `concurrency` option](http://bluebirdjs.com/docs/api/promise.map.html) since [2.0](http://bluebirdjs.com/docs/changelog.html#what), [released in June 2014](https://www.npmjs.com/package/bluebird/v/2.0.2).
- [Async's had `eachLimit` (formerly `forEachLimit`) since 0.1.10](https://github.com/caolan/async/commit/90c80a15f3f49bfa75880a6c724d4aceccb9ea4a), [released in October 2011](https://www.npmjs.com/package/async/v/0.1.13).
- [When's had `when/guard` for concurrency control since 2.1.0](https://github.com/cujojs/when/blob/master/CHANGES.md#210), [released in May 2013](https://www.npmjs.com/package/when/v/2.1.0).
- [`d3-queue`'s had a concurrency option since the initial commit in January 2012.](https://github.com/d3/d3-queue/tree/581e4941c5437d31db92066f4bd3684c0b468a28)

<details>
<summary>Case study: combining data from multiple sources in parallel while avoiding resource leaks on error</summary>

Consider this code, taken from [here](https://github.com/awslabs/aws-api-gateway-developer-portal/blob/18e152bdbb398358b15e0b713862fb6d9a3cba95/lambdas/catalog-updater/index.js#L189-L267). The ultimate goal of it is to read both the usage plans and Swagger files concurrently, but still coordinate the catalog builder construction correctly. Oh, and if any errors occur within tasks, we should abort the Swagger file iteration so we aren't still trying to build. This does *not* require limiting concurrency, however.

```js
const handler = (event) => new Promise((resolve, reject) => {
  console.log(`event: ${inspect(event)}`)

  let s3Request
  let builder = []
  let open = 1

  function abort (err) {
    if (open === 0) return
    open = 0
    if (s3Request != null) {
      s3Request.abort()
      s3Request = null
    }
    return reject(err)
  }

  function complete () {
    if (open === 0) return
    open--
    if (open === 0) {
      console.log(`catalog: ${inspect(builder.catalog)}`)

      const params = {
        Bucket: process.env.BucketName,
        Key: 'catalog.json',
        Body: JSON.stringify(builder.catalog),
        ContentType: 'application/json'
      }

      resolve(exports.s3.upload(params).promise())
    }
  }

  const usagePlansPromise = getAllUsagePlans(exports.apiGateway)
  usagePlansPromise.catch(abort)
  exports.s3.getObject({ Bucket: process.env.BucketName, Key: 'sdkGeneration.json' }).promise()
    .then(response => {
      const sdkGeneration = JSON.parse(response.Body.toString())
      console.log(`sdkGeneration: ${inspect(sdkGeneration)}`)
      usagePlansPromise.then(usagePlans => {
        const swaggers = builder
        console.log(`usagePlans: ${inspect(usagePlans)}`)
        builder = new CatalogBuilder(usagePlans, sdkGeneration)
        for (const s of swaggers) builder.addToCatalog(s)
        complete()
      })
    }, abort)

  function consumeNext (listObjectsResult) {
    if (listObjectsResult.IsTruncated) loop(listObjectsResult.NextContinuationToken)
    for (const file of listObjectsResult.Contents) {
      if (exports.swaggerFileFilter(file)) {
        open++
        getSwaggerFile(file).then(s => {
          complete()
          if (Array.isArray(builder)) {
            builder.push(s)
          } else {
            builder.addToCatalog(s)
          }
        }, abort)
      }
    }
    complete()
  }

  function loop (token) {
    open++
    s3Request = exports.s3.listObjectsV2(
      token != null
        ? { Bucket: process.env.BucketName, Prefix: 'catalog/', ContinuationToken: token }
        : { Bucket: process.env.BucketName, Prefix: 'catalog/' }
    )
    s3Request.promise().then(consumeNext, abort)
  }

  loop()
})
```

This runs very hard into the open counter idiom I noted initially. It's also borderline spaghetti.

The following code uses the proposed `Promise.scheduleAndRun`, and is considerably simpler and easier to understand - in fact, it takes only 60% of the code while still remaining much clearer on what's going on. And yes, it fulfills all the above constraints on operation ordering, too.

```js
const handler = async (event) => {
  console.log(`event: ${inspect(event)}`)

  let s3Request

  await Promise.scheduleAndRun(async schedule => {
    const builderPromise = schedule(async () => {
      const usagePlansPromise = getAllUsagePlans(exports.apiGateway)
      const response = await exports.s3.getObject({ Bucket: process.env.BucketName, Key: 'sdkGeneration.json' }).promise()
      const sdkGeneration = JSON.parse(response.Body.toString())
      console.log(`sdkGeneration: ${inspect(sdkGeneration)}`)
      const usagePlans = await usagePlansPromise
      console.log(`usagePlans: ${inspect(usagePlans)}`)
      return new CatalogBuilder(usagePlans, sdkGeneration)
    })

    let token
    do {
      s3Request = exports.s3.listObjectsV2(
        token != null
          ? { Bucket: process.env.BucketName, Prefix: 'catalog/', ContinuationToken: token }
          : { Bucket: process.env.BucketName, Prefix: 'catalog/' }
      )
      const listObjectsResult = await s3Request.promise()
      for (const file of listObjectsResult.Contents) {
        if (exports.swaggerFileFilter(file)) {
          schedule(async () => {
            const s = await getSwaggerFile(file)
            ;(await builderPromise).addToCatalog(s)
          })
        }
      }
      if (!listObjectsResult.IsTruncated) break
      token = listObjectsResult.NextContinuationToken
    } while (s3Request != null)
  }, {
    onRejected(e) {
      if (s3Request != null) {
        s3Request.abort()
        s3Request = null
      }
      throw e
    }
  })
})
```

Here, it aids readability, and makes it abundantly clear what each operation is. I didn't have to contort, and it does exactly what it looks like it does.

> Also, this example here is why I chose not to propose a simple parallel map. Task queues are the underlying primitive, and the underlying primitive is considerably more broad in its utility.

</details>

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
    scheduleAndRun<InitResult>(
        // Note: this outer function counts against the concurrency limit, and
        // for statistical purposes counts as a task remaining. However, it does
        // *not* result in invoking `onResolved` or `onRejected` - instead, it
        // impacts whether the outer promise resolves or rejects.
        init: (
            // Returns `true` if the function was scheduled immediately, `false`
            // otherwise.
            // This can be called even during child task execution, but locks as
            // soon as the last remaining task result resolves.
            schedule: <TaskResult>(
                task: () => TaskResult | PromiseLike<TaskResult>
            ) => Promise<TaskResult>
        ) => InitResult | PromiseLike<InitResult>,
        options: {
            // Set the max concurrency. If `Infinity`, no concurrency limit
            // exists, and if less than 1, it throws a `RangeError`.
            maxConcurrency?: number;
            // Called once a task resolves. The default behavior is to do
            // nothing.
            onResolved?(): void;
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

    await Promise.scheduleAndRun(
        schedule => init(task => schedule(async () => {
            results.push(await task())
        })),
        opts
    )

    return results
}

const results = await runAndCollect(schedule => {
    for (const item of list) {
        schedule(() => callApi({id: item.id, ...}))
    }
}, {
    maxConcurrency: 10,
    onResolved: advanceProgressBar,
})

completeProgressBar()
```

## Proposed polyfill

Here's a possible polyfill of what I'm proposing. Only a very rudimentary attempt is made to ensure performance, and the spec text would roughly equate to this.

> As you can see, this is very non-trivial and somewhat involved, despite the relative simplicity of the API - it's a whole 94 lines of code excluding whitespace, and that's without any sort of defensive coding at all that's more typical of polyfills. I would not expect most people that aren't at least passingly familiar with computer science to be able to come up with this very quickly.
>
> If you want a more optimized polyfill suitable to try out in more real world-y situations, take a look at `polyfill.js` here in the project root. Of course, it's a bit more involved, but 1. performance is neither simple nor easy and 2. it's also intended to inform engine implementation.

```js
if (!Promise.scheduleAndRun) {
    Promise.scheduleAndRun = (initialize, opts) => {
        "use strict"

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

            function onTaskResolve() {
                if (opts != null) {
                    try {
                        const hook = opts.onResolved
                        if (hook != null) {
                            hook.call(opts)
                        }
                    } catch (e) {
                        errors.push(value)
                    }
                }

                settleTask()
            }

            function onTaskReject(error) {
                handleRejection: {
                    if (opts != null) {
                        try {
                            const hook = opts.onRejected
                            if (hook != null) {
                                hook.call(opts, value)
                                break handleRejection
                            }
                        } catch (e) {
                            error = e
                        }
                    }

                    errors.push(value)
                }

                settleTask()
            }

            function settleTask() {
                const next = queue.shift()

                if (next != null) {
                    const {task, resolve} = next

                    const promise = new Promise(resolve => {
                        resolve(task())
                    })

                    resolve(promise)

                    promise.then(onTaskResolve, onTaskReject)
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

            const schedule = task => {
                if (active === 0) throw new Error("Scheduler locked!")

                const p = new Promise(resolve => {
                    queue.push({
                        task: task,
                        resolve: resolve,
                    })
                })

                if (active < maxConcurrency) {
                    active++
                    Promise.resolve().then(settleTask)
                }

                return p
            }

            new Promise(resolve => {
                resolve(initialize(schedule))
            }).then(
                value => {
                    initalizerResult = value
                    onTaskResolve()
                },
                onTaskReject
            )
        })
    }
}
```

## Follow-on: Task options

This would be useful for coordinating tasks, and would mean people wouldn't have to roll their own task queues just to run stuff. There's two options I can think of right off:

- Priority - this would mean a binary heap would have to be used rather than a simple array for proper efficiency.
- Weight (as in counting more than once towards concurrency) - the initializer would also necessarily have to have this option

This follow-on is *not* included in the polyfills, as at least with priority it's once again not the easiest to add.

There's not a lot of library precedent for this outside like heavy message brokers and such, but I did find one that's getting a decent number (just under 86k as of 2021 March 28) of weekly downloads: [`vow-queue`](https://www.npmjs.com/package/vow-queue). And [that's had those options since its initial commit, too](https://github.com/dfilatov/vow-queue/blob/be19316c3fe238b10a79e26421f6d8149c7af452/lib/queue.js).
