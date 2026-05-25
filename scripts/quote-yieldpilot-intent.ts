import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type CliOptions = {
  live: boolean;
  fixture: boolean;
  json: boolean;
};

type QuoteFixture = {
  source: "fixture" | "live";
  scenario: string;
  request: {
    user: string;
    intent: {
      intentType: string;
      swapType: "exact-input" | "exact-output";
      inputs: Array<{
        label: string;
        chain: string;
        chainId: number;
        user: string;
        token: string;
        asset: string;
        amount: string | null;
      }>;
      outputs: Array<{
        label: string;
        chain: string;
        chainId: number;
        token: string;
        receiver: string;
        asset: string;
        amount: string | null;
      }>;
    };
    supportedTypes: string[];
  };
  quote: {
    quoteId: string;
    validUntil: number;
    inputSettler: string;
    requiredInputAmount: string;
    requiredInputToken: string;
    fixedOutputAmount: string;
    fixedOutputToken: string;
    failureHandling: string;
    partialFill: boolean;
    metadata: {
      exclusiveFor: string | null;
      solverModel: string;
    };
  };
  standardOrder: {
    user: string;
    nonce: string;
    originChainId: string;
    expires: number;
    fillDeadline: number;
    inputOracle: string;
    inputs: [string, string][];
    outputs: Array<{
      oracle: string;
      settler: string;
      chainId: string;
      token: string;
      amount: string;
      recipient: string;
      call: string;
      context: string;
    }>;
  };
  tracking: {
    openEvent: string;
    orderIdPreview: string;
    statusEndpoint: string;
    terminalStates: string[];
  };
};

type LifiQuoteResponse = {
  quotes?: Array<{
    quoteId?: string;
    validUntil?: number;
    preview?: {
      inputs?: Array<{ amount?: string }>;
      outputs?: Array<{ amount?: string }>;
    };
    failureHandling?: string;
    partialFill?: boolean;
    metadata?: {
      exclusiveFor?: string | null;
    };
  }>;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(__dirname, "../fixtures/yieldpilot-intent-quote.json");
const quoteUrl = process.env.LIFI_INTENTS_QUOTE_URL ?? "https://order.li.fi/quote/request";

function parseArgs(argv: string[]): CliOptions {
  const live = argv.includes("--live") || process.env.LIFI_INTENTS_LIVE === "1";
  const fixture = argv.includes("--fixture") || !live;

  return {
    live,
    fixture,
    json: argv.includes("--json")
  };
}

async function loadFixture(): Promise<QuoteFixture> {
  return JSON.parse(await readFile(fixturePath, "utf8")) as QuoteFixture;
}

function toDecimalAmount(amount: string, decimals = 6): string {
  const padded = amount.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

async function fetchLiveQuote(base: QuoteFixture): Promise<QuoteFixture> {
  const response = await fetch(quoteUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(base.request)
  });

  if (!response.ok) {
    throw new Error(`LI.FI quote request failed: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as LifiQuoteResponse;
  const best = data.quotes?.[0];
  const requiredInputAmount = best?.preview?.inputs?.[0]?.amount;
  const fixedOutputAmount = best?.preview?.outputs?.[0]?.amount;

  if (!best?.quoteId || !requiredInputAmount || !fixedOutputAmount) {
    throw new Error("LI.FI quote response did not include quoteId and preview amounts");
  }

  return {
    ...base,
    source: "live",
    quote: {
      ...base.quote,
      quoteId: best.quoteId,
      validUntil: best.validUntil ?? Math.floor(Date.now() / 1000) + 120,
      requiredInputAmount,
      fixedOutputAmount,
      failureHandling: best.failureHandling ?? base.quote.failureHandling,
      partialFill: best.partialFill ?? base.quote.partialFill,
      metadata: {
        exclusiveFor: best.metadata?.exclusiveFor ?? null,
        solverModel: "standing-quote inventory"
      }
    },
    standardOrder: {
      ...base.standardOrder,
      inputs: [[base.standardOrder.inputs[0][0], requiredInputAmount]],
      outputs: [
        {
          ...base.standardOrder.outputs[0],
          amount: fixedOutputAmount
        }
      ]
    }
  };
}

function toOutputShape(quote: QuoteFixture, warning?: string) {
  const input = quote.request.intent.inputs[0];
  const output = quote.request.intent.outputs[0];

  return {
    marker: "LIFI_INTENTS_YIELDPILOT_PLAYBOOK_READY",
    source: quote.source,
    warning,
    scenario: quote.scenario,
    input: {
      chain: input.chain,
      chainId: input.chainId,
      token: input.token,
      asset: input.asset,
      requiredAmount: quote.quote.requiredInputAmount,
      requiredAmountHuman: `${toDecimalAmount(quote.quote.requiredInputAmount)} ${quote.quote.requiredInputToken}`
    },
    output: {
      chain: output.chain,
      chainId: output.chainId,
      token: output.token,
      asset: output.asset,
      fixedAmount: quote.quote.fixedOutputAmount,
      fixedAmountHuman: `${toDecimalAmount(quote.quote.fixedOutputAmount)} ${quote.quote.fixedOutputToken}`
    },
    solverQuote: {
      quoteId: quote.quote.quoteId,
      validUntil: quote.quote.validUntil,
      solverModel: quote.quote.metadata.solverModel,
      exclusiveFor: quote.quote.metadata.exclusiveFor,
      partialFill: quote.quote.partialFill,
      failureHandling: quote.quote.failureHandling
    },
    inputSettlerEscrow: quote.quote.inputSettler,
    standardOrder: quote.standardOrder,
    tracking: quote.tracking,
    nextSteps: [
      "Approve or permit InputSettlerEscrow for the quoted input amount.",
      "Open the StandardOrder on the payment chain, or submit through the order server if using a gasless flow.",
      "Read orderId from the Open event topic, then poll /orders/status until Delivered or Settled."
    ],
    boundary: "This script previews the YieldPilot intent shape. It does not spend funds or submit an order unless extended with wallet signing."
  };
}

function printHuman(result: ReturnType<typeof toOutputShape>) {
  if (result.warning) {
    console.log(`warning: ${result.warning}`);
    console.log("");
  }

  console.log(result.marker);
  console.log("");
  console.log(`source: ${result.source}`);
  console.log(`scenario: ${result.scenario}`);
  console.log("");
  console.log("intent");
  console.log(`  input:  ${result.input.requiredAmountHuman} on ${result.input.chain} (${result.input.asset})`);
  console.log(`  output: ${result.output.fixedAmountHuman} on ${result.output.chain} (${result.output.asset})`);
  console.log("");
  console.log("solver quote");
  console.log(`  quoteId: ${result.solverQuote.quoteId}`);
  console.log(`  model:   ${result.solverQuote.solverModel}`);
  console.log(`  expiry:  ${result.solverQuote.validUntil}`);
  console.log(`  refund:  ${result.solverQuote.failureHandling}`);
  console.log("");
  console.log("input settler");
  console.log(`  InputSettlerEscrow: ${result.inputSettlerEscrow}`);
  console.log("");
  console.log("StandardOrder");
  console.log(JSON.stringify(result.standardOrder, null, 2));
  console.log("");
  console.log("tracking");
  console.log(`  event:    ${result.tracking.openEvent}`);
  console.log(`  orderId:  ${result.tracking.orderIdPreview}`);
  console.log(`  status:   ${result.tracking.statusEndpoint}`);
  console.log(`  terminal: ${result.tracking.terminalStates.join(" / ")}`);
  console.log("");
  console.log("boundary");
  console.log(`  ${result.boundary}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const fixture = await loadFixture();
  let warning: string | undefined;
  let quote = fixture;

  if (options.live && !options.fixture) {
    try {
      quote = await fetchLiveQuote(fixture);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warning = `live quote unavailable; using fixture with the same output shape. ${message}`;
      quote = fixture;
    }
  }

  const result = toOutputShape(quote, warning);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printHuman(result);
}

await main();
