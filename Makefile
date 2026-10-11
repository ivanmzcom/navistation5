.PHONY: all test clean
all:
	python3 tools/build.py
test:
	npm test
clean:
	rm -rf build
