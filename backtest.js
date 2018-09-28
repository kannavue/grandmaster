/**
 * backtest.js
 *
 * Runs a backtest for a given strategy (defined via the -s flag)
 * over all (or a subset of) the available history for a given symbol.
 *
 * Supports the following options:
 *  - Set the beginning/ending dates for the backtest.
 *      -b|--begin [DATE] (e.g. 2018-01-01)
 *      -e|--end [DATE]
 *
 *  - Output the list of BUY and SELL signals generated by the
 *    strategy along with the performance summary.
 *      -v|--verbose
 *
 *  - Set the amount of capital to use when running the backtest.
 *      -c|--capital [NUMBER] (default is 1000)
 *
 *  - Output the results to a file (instead of console/stdout)
 *      -o|--tofile
 *
 *  - Output all data (bars and any strategy-specific indicators) to
 *    a file for debugging.
 *      -d|--debug
 */

const cliParams = [
    { name: 'strategy', alias: 's', type: String,   defaultOption: true },
    { name: 'verbose',  alias: 'v', type: Boolean,  defaultValue: false },
    { name: 'capital',  alias: 'c', type: Number,   defaultValue: 1000 },
    { name: 'begin',    alias: 'b', type: String,   defaultValue: '' },
    { name: 'end',      alias: 'e', type: String,   defaultValue: '' },
    { name: 'tofile',   alias: 'o', type: Boolean,  defaultValue: false },
    { name: 'debug',    alias: 'd', type: Boolean,  defaultValue: false }
]
const params = require('command-line-args')(cliParams)

if (undefined === params.strategy) {
    console.log('[!] ERROR: You must specify a strategy using the -s flag')
    process.exit()
}

// Load config/environment vars from .env file
require('dotenv').config()

// Load strategy-specific config from the strategy folder
const config = require(`./strategies/${params.strategy}/config`)

// Load the strategy definition from the strategy folder
const Strategy = require(`./strategies/${params.strategy}/strategy`)

// Initialize a new instance of the Strategy, passing in the
// configured symbols
const strategy = new Strategy(Object.keys(config.symbols))

const fs = require('fs')

// Initialize MySQL connection based on config in .env file
const mysql = require('mysql')
const db = mysql.createConnection({
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASS,
    database: process.env.MYSQL_DB,
    multipleStatements: true
})
const { table, getBorderCharacters } = require('table')
let symbols = {}
let queries = []

// Retrieve historic data (bars) for each symbol indicated in the
// strategy config file optionally limiting the data retrieved to the
// beginning and/or ending dates specified by the user at runtime
Object.keys(config.symbols).forEach(symbol => {
    if (params.begin && params.begin !== '') {
        if (params.end && params.end !== '') {
            queries.push(`SELECT *, '${symbol}' AS symbol FROM \`${symbol.toLowerCase()}\` WHERE \`start\` >= '${params.begin}' AND \`start\` <= '${params.end}' ORDER BY \`start\` ASC`)
        } else {
            queries.push(`SELECT *, '${symbol}' AS symbol FROM \`${symbol.toLowerCase()}\` WHERE \`start\` >= '${params.begin}' ORDER BY \`start\` ASC`)
        }
    } else {
        if (params.end && params.end !== '') {
            queries.push(`SELECT *, '${symbol}' AS symbol FROM \`${symbol.toLowerCase()}\` WHERE \`start\` <= '${params.end}' ORDER BY \`start\` ASC`)
        } else {
            queries.push(`SELECT *, '${symbol}' AS symbol FROM \`${symbol.toLowerCase()}\` ORDER BY \`start\` ASC`)
        }
    }

    symbols[symbol] = {
        trades: [],
        output: [],
        capital: params.capital
    }
})

db.query(queries.join(';'), (error, results) => {
    if (error) {
        console.log(`[!] MySQL ERROR: ${error.message}`)
        db.end(() => { process.exit() })
        return
    }

    // For each symbol, replay the historical data bar by bar into
    // the strategy and log the signals generated by the strategy
    // for analysis and output when it's done executing.
    if (queries.length > 1) {
        results.forEach(result => {
            result.forEach(bar => {
                strategy.addBar(bar.symbol, bar, logSignal)
            })
        })
    } else {
        results.forEach(bar => {
            strategy.addBar(bar.symbol, bar, logSignal)
        })
    }

    db.end(() => {})

    // Collect and output the results for each symbol that was
    // backtested.
    Object.keys(symbols).forEach(symbol => {
        if (symbols[symbol].trades.length > 0) {
            let lastTrade = symbols[symbol].trades.pop()
            let i = (strategy.symbols[symbol].times.length - 1)

            // Determine if all trades were closed, if not close the
            // last trade at the last known bar for the purpose of
            // calculating returns, profit/loss, etc. Indicate in the
            // output that the last trade was assumed closed instead
            // of closed as a result of a signal from the strategy.
            if (lastTrade.sell.price === null) {
                let d = new Date(strategy.symbols[symbol].times[i])

                lastTrade.sell.timestamp = d.getTime()
                lastTrade.sell.price = strategy.symbols[symbol].close[i]
                lastTrade.sell.revenue = (lastTrade.sell.price * lastTrade.buy.qty)
                lastTrade.profit.amt = (lastTrade.sell.revenue - lastTrade.buy.cost)
                lastTrade.profit.pct = (((lastTrade.sell.revenue - lastTrade.buy.cost) / lastTrade.buy.cost) * 100)
                lastTrade.stats.timeHeld = ((lastTrade.sell.timestamp - lastTrade.buy.timestamp) / 1000 / 60)

                if (params.verbose) {
                    symbols[symbol].output.push(['[****]', ' ', d.toISOString(), `$${lastTrade.sell.price.toFixed(2)}`, `$${lastTrade.profit.amt.toFixed(2)}`, `${lastTrade.profit.pct.toFixed(2)}%`])
                }
            }

            symbols[symbol].trades.push(lastTrade)

            // If the debug flag is set, output all the data to a file.
            if (params.debug) {
                outputData(symbol)
            }

            // Generate the strategy performance summary based on the
            // trades executed according to the signals generated.
            generateSummary(symbol)
        }

        let _output = null

        if (params.verbose) {
            symbols[symbol].output.unshift(['Signal', 'Symbol', 'Date', 'Price', 'P/L $', 'P/L %'])

            _output = table(symbols[symbol].output, {
                columns: {
                    0: { alignment: 'left' },
                    1: { alignment: 'left' },
                    2: { alignment: 'right' },
                    3: { alignment: 'right' },
                    4: { alignment: 'right' },
                    5: { alignment: 'right' }
                },
                border: getBorderCharacters('norc')
            })
        } else {
            _output = table(symbols[symbol].output, {
                columns: {
                    0: { alignment: 'left' },
                    1: { alignment: 'right' },
                    2: { alignment: 'right' },
                    3: { alignment: 'right' }
                },
                border: getBorderCharacters('norc')
            })
        }

        // If the tofile flag was set, output the results to a file,
        // otherwise output to the console.
        if (params.tofile) {
            fs.writeFileSync(`./strategies/${params.strategy}/backtest_${symbol}.txt`, _output, { encoding: 'utf-8' })
        } else {
            console.log(_output)
        }
    })
})

/**
 * Callback function that logs the signal, either BUY or SELL,
 * from the strategy.
 *
 * @param Object signal     See `BaseStrategy.addbar()` for the
 *                          structure of the `signal` object.
 *
 * @returns null
 */
function logSignal (signal) {
    if (signal.buy === true) {
        let d = new Date(signal.bar.start)
        let s = signal.symbol

        if (params.verbose) {
            symbols[s].output.push(['[BUY]', s, d.toISOString(), `$${signal.bar.close.toFixed(2)}`, ' ', ' '])
        }

        // Calculate the number of shares purchased based on the
        // closing price and the capital available.
        let qty = Number(Math.floor(symbols[s].capital / signal.bar.close))
        let cost = Number(signal.bar.close * qty).toFixed(2)

        symbols[s].trades.push({
            buy: {
                timestamp: d.getTime(),
                price: signal.bar.close,
                qty: qty,
                cost: cost
            },
            sell: {
                timestamp: null,
                price: null,
                revenue: null
            },
            profit: {
                amt: null,
                pct: null
            },
            stats: {
                timeHeld: null
            }
        })
    } else if (signal.sell === true) {
        let d = new Date(signal.bar.start)
        let s = signal.symbol
        let trade = symbols[s].trades.pop()

        trade.sell.timestamp = d.getTime()
        trade.sell.price = signal.bar.close
        trade.sell.revenue = (signal.bar.close * trade.buy.qty)
        trade.profit.amt = (trade.sell.revenue - trade.buy.cost)
        trade.profit.pct = (((trade.sell.revenue - trade.buy.cost) / trade.buy.cost) * 100)
        trade.stats.timeHeld = ((trade.sell.timestamp - trade.buy.timestamp) / 1000 / 60)

        if (params.verbose) {
            symbols[s].output.push(['[SELL]', ' ', d.toISOString(), `$${trade.sell.price.toFixed(2)}`, `$${trade.profit.amt.toFixed(2)}`, `${trade.profit.pct.toFixed(2)}%`])
        }

        symbols[s].trades.push(trade)
    }
}

/**
 * Generate a performance summary based on the trades executed during
 * the backtest. This summary includes:
 *  - Total profit/loss
 *  - Number of trades executed
 *  - Percent of trades won/lost
 *  - Average win/loss amounts
 *  - Average percentage win/loss
 *  - Hypothetical profit/loss from buy & hold over the same time
 *  - Average time position was held (in minutes)
 *  - Average number of trades executed per day
 *
 * TODO:
 *  - Add max drawdown
 *  - Add average drawdown
 *
 * @param Object symbol
 *
 * @returns null
 */
function generateSummary (symbol) {
    let trades = symbols[symbol].trades
    let output = symbols[symbol].output

    // Calculate the total profit/loss from all trades
    let totalProfit = trades.reduce((profit, trade) => {
        if (trade.sell.price === null) {
            return profit
        } else {
            return (profit + trade.profit.amt)
        }
    }, 0)

    // Calculate the total profit/loss percent from all trades
    let totalProfitPct = trades.reduce((pct, trade) => {
        if (trade.sell.price === null) {
            return pct
        } else {
            return pct + trade.profit.pct
        }
    }, 0)

    // Calculate the win/loss ratio from all trades
    let numWin = trades.reduce((count, trade) => {
        if ((trade.profit.amt === null) || (trade.profit.amt > 0)) {
            return (count + 1)
        } else {
            return count
        }
    }, 0)

    let pctWin = ((numWin / trades.length) * 100)
    let pctLoss = (100 - pctWin)

    // Calculate the average time a position was held, in minutes
    let avgTimeHeld = (trades.reduce((minutes, trade) => {
        if (trade.stats.timeHeld === null) {
            return minutes
        } else {
            return (minutes + trade.stats.timeHeld)
        }
    }, 0) / trades.length)

    // Calculate the average trades executed per day
    let numDays = ((trades[trades.length - 1].buy.timestamp - trades[0].buy.timestamp) / 1000 / 60 / 60 / 24)
    let avgTradesPerDay = (trades.length / numDays)

    // Calculate the average win dollar amount
    let avgWinAmt = (trades.reduce((totalWin, trade) => {
        if ((trade.profit.amt !== null) && (trade.profit.amt > 0)) {
            return (totalWin + trade.profit.amt)
        } else {
            return totalWin
        }
    }, 0) / numWin)

    // Calculate the average loss dollar amount
    let avgLossAmt = (trades.reduce((totalLoss, trade) => {
        if ((trade.profit.amt !== null) && (trade.profit.amt <= 0)) {
            return (totalLoss + trade.profit.amt)
        } else {
            return totalLoss
        }
    }, 0) / (trades.length - numWin))

    // Calculate the average win percent return
    let avgWinPct = (trades.reduce((totalWin, trade) => {
        if ((trade.profit.pct !== null) && (trade.profit.pct > 0)) {
            return (totalWin + trade.profit.pct)
        } else {
            return totalWin
        }
    }, 0) / numWin)

    // Calculate the average loss percent return
    let avgLossPct = (trades.reduce((totalLoss, trade) => {
        if ((trade.profit.pct !== null) && (trade.profit.pct <= 0)) {
            return (totalLoss + trade.profit.pct)
        } else {
            return totalLoss
        }
    }, 0) / (trades.length - numWin))

    // Calculate the buy and hold profit/loss (dollar amount and
    // percent return) over the same time period for comparison
    let buyHoldQty = Number((params.capital / strategy.symbols[symbol].close[0]).toFixed(2))
    let buyHoldAmt = ((strategy.symbols[symbol].close.splice(-1)[0] * buyHoldQty) - (strategy.symbols[symbol].close[0] * buyHoldQty))
    let buyHoldPct = ((strategy.symbols[symbol].close.splice(-1)[0] - strategy.symbols[symbol].close[0]) / strategy.symbols[symbol].close[0])

    if (params.verbose) {
        output.push([' ', ' ', ' ', ' ', ' ', ' '])
    }

    if (params.verbose) {
        output.push([' ', 'Total Profit (Loss)', ' ', ' ', `$${totalProfit.toFixed(2)}`, `${totalProfitPct.toFixed(2)}%`])
        output.push([' ', 'Trade Count', ' ', `${trades.length}`, `${numWin}`, `${(trades.length - numWin)}`])
        output.push([' ', 'Trade Win (Loss) %', ' ', ' ', `${pctWin.toFixed(2)}%`, `${pctLoss.toFixed(2)}%`])
        output.push([' ', 'Avg Win (Loss) $', ' ', ' ', `$${avgWinAmt.toFixed(2)}`, `$${avgLossAmt.toFixed(2)}`])
        output.push([' ', 'Avg Win (Loss) %', ' ', ' ', `${avgWinPct.toFixed(2)}%`, `${avgLossPct.toFixed(2)}%`])
        output.push([' ', 'Buy & Hold P(L)', ' ', ' ', `$${buyHoldAmt.toFixed(2)}`, `${(buyHoldPct * 100).toFixed(2)}%`])
        output.push([' ', 'Avg Time Held', `${avgTimeHeld.toFixed(0)} minutes`, ' ', ' ', ' '])
        output.push([' ', 'Avg Trades/Day', `~${avgTradesPerDay.toFixed(0)} trades/day`, ' ', ' ', ' '])
    } else {
        output.push(['Total Profit (Loss)', ' ', `$${totalProfit.toFixed(2)}`, `${totalProfitPct.toFixed(2)}%`])
        output.push(['Trade Count', `${trades.length}`, `${numWin}`, `${(trades.length - numWin)}`])
        output.push(['Trade Win (Loss) %', ' ', `${pctWin.toFixed(2)}%`, `${pctLoss.toFixed(2)}%`])
        output.push(['Avg Win (Loss) $', ' ', `$${avgWinAmt.toFixed(2)}`, `$${avgLossAmt.toFixed(2)}`])
        output.push(['Avg Win (Loss) %', ' ', `${avgWinPct.toFixed(2)}%`, `${avgLossPct.toFixed(2)}%`])
        output.push(['Buy & Hold P(L)', ' ', `$${buyHoldAmt.toFixed(2)}`, `${(buyHoldPct * 100).toFixed(2)}%`])
        output.push(['Avg Time Held', `${avgTimeHeld.toFixed(0)} minutes`, ' ', ' '])
        output.push(['Avg Trades/Day', `~${avgTradesPerDay.toFixed(0)} trades/day`, ' ', ' '])
    }
}

/**
 * Output all data associated with this backtest (bars and indicators)
 * to a file for debugging.
 *
 * @param Object symbol
 */
function outputData(symbol) {
    let rows = []
    let s = strategy.symbols[symbol]
    let indicators = Object.keys(s.indicators)
    let indicatorValues = {}
    let trades = {}

    let headerRow = ['date', 'open', 'high', 'low', 'close', 'volume', 'trades']

    indicators.forEach(indicator => {
        headerRow.push(indicator)
        indicatorValues[indicator] = s.indicators[indicator].getValues()
    })

    headerRow.push('signal')
    rows.push(headerRow)

    symbols[symbol].trades.forEach(trade => {
        trades[trade.buy.timestamp] = 1
        trades[trade.sell.timestamp] = 2
    })

    s.times.forEach((time, index) => {
        let row = [time, s.open[index], s.high[index], s.low[index], s.close[index], s.volume[index], s.trades[index]]

        indicators.forEach(indicator => {
            if (indicatorValues[indicator][index]) {
                row.push(indicatorValues[indicator][index])
            } else {
                row.push(0)
            }
        })

        if (trades[time]) {
            row.push(trades[time])
        } else {
            row.push(0)
        }

        rows.push(row)
    })

    let csv = []

    rows.forEach(row => {
        csv.push(row.join(','))
    })

    fs.writeFileSync(`./strategies/${params.strategy}/debug.csv`, csv.join('\r\n'))
}