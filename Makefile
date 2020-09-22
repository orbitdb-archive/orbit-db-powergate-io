.PHONY: test
.PHONY: docs

docs:
	rm -rf docs
	npx jsdoc -r src/*.js -d docs -R README.md --verbose

up:
	BIGSECTORS=true docker-compose up -d

lint:
	npx standard src/ test/

deps:
	npm install

down:
	BIGSECTORS=true docker-compose down

test: lint up deps
	npm test
	make down

clean: down
	rm -rf orbitdb
	rm -rf node_modules
	rm -f package-lock.json

rebuild: clean down test
