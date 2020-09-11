.PHONY: test

build: 
	npm install

test:
	BIGSECTORS=true docker-compose up -d
	npm install
	npm test

clean:
	rm -rf orbitdb
	rm -rf node_modules
	rm -f package-lock.json

rebuild:
	rm -rf orbitdb
	rm -rf node_modules
	rm -f package-lock.json
	npm install
