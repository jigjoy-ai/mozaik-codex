import { defineConfig } from "@rstest/core"

// The integration test runs the server against the network itself: the server is taken from
// the mozaik-network repository, with the path aliases its source is written with.
const network = "./node_modules/mozaik-network/src"

export default defineConfig({
	include: ["tests/**/*.test.ts"],
	testEnvironment: "node",
	// The server is started as separate processes: the first start after an install is slow.
	testTimeout: 20_000,
	resolve: {
		alias: {
			"@application": `${network}/application`,
			"@domain": `${network}/domain`,
			"@infrastructure": `${network}/infrastructure`,
			src: network,
		},
	},
})
