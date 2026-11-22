.PHONY: help build test pages

ESBUILD ?= npx --yes --quiet esbuild@0.28.2

help:
	@printf '%s\n' \
	  'make build' \
	  'make test' \
	  './build/create-rate.mjs recipes create:andesite_alloy' \
	  './build/create-rate.mjs time create:mixing/andesite_alloy --rpm 64' \
	  './build/create-rate.mjs rates plant.yaml' \
	  'cat plant.yaml | ./build/create-rate.mjs rates -' \
	  './build/create-rate.mjs terminal' \
	  './build/create-rate.mjs capacity create:mixing/andesite_alloy --rpm 64 --input minecraft:andesite=20 --input minecraft:iron_nugget=20 --target 10' \
	  './build/create-rate.mjs capacity create:compacting/andesite_from_flint --rpm 64 --input minecraft:flint=40 --input minecraft:gravel=20 --input fluid:minecraft:lava=2000 --target 10'

build:
	mkdir -p build
	$(ESBUILD) src/cli.ts --bundle --platform=node --format=esm --banner:js='#!/usr/bin/env node' --outfile=build/create-rate.mjs
	chmod +x build/create-rate.mjs
	$(ESBUILD) src/export-recipes.ts --bundle --platform=node --format=esm --outfile=build/export-recipes.mjs
	node build/export-recipes.mjs
	$(ESBUILD) src/ui/index.ts --bundle --platform=browser --format=esm --outfile=build/ui.js

test:
	mkdir -p build
	$(ESBUILD) tests/machine-bound.test.ts --bundle --platform=node --format=esm --outfile=build/machine-bound.test.mjs
	node build/machine-bound.test.mjs
	$(ESBUILD) tests/plant-editing.test.ts --bundle --platform=node --format=esm --outfile=build/plant-editing.test.mjs
	node build/plant-editing.test.mjs
	$(ESBUILD) tests/recipe-choices.test.ts --bundle --platform=node --format=esm --outfile=build/recipe-choices.test.mjs
	node build/recipe-choices.test.mjs
	$(ESBUILD) tests/architecture-rules.test.ts --bundle --platform=node --format=esm --outfile=build/architecture-rules.test.mjs
	node build/architecture-rules.test.mjs
	$(ESBUILD) tests/matching-gestures.test.ts --bundle --platform=node --format=esm --outfile=build/matching-gestures.test.mjs
	node build/matching-gestures.test.mjs

pages: build
	mkdir -p build/site/src build/site/build build/site/data
	cp index.html build/site/index.html
	cp src/ui.css build/site/src/ui.css
	cp build/ui.js build/browser-recipes.json build/site/build/
	cp -R data/item-icons build/site/data/
	if [ -f data/item-models.json.gz ]; then cp data/item-models.json.gz build/site/data/; fi
