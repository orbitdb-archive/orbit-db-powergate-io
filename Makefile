.PHONY: test

up:
	BIGSECTORS=true docker-compose up -d

deps:
	npm install

down:
	BIGSECTORS=true docker-compose down

test: up deps
	npm test
	make down

clean: down
	rm -rf orbitdb
	rm -rf node_modules
	rm -f package-lock.json

rebuild: clean down test
