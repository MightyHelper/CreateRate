.PHONY: help build pages

ESBUILD ?= npx --yes --quiet esbuild

help:
	@printf '%s\n' \
	  'make build' \
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

pages: build
	mkdir -p build/site/src build/site/build build/site/data
	cp index.html build/site/index.html
	cp src/ui.css build/site/src/ui.css
	cp build/ui.js build/browser-recipes.json build/site/build/
	cp -R data/item-icons build/site/data/
	if [ -f data/item-models.json.gz ]; then cp data/item-models.json.gz build/site/data/; fi
