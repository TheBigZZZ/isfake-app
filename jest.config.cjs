/** @type {import('jest').Config} */
module.exports = {
	preset: 'ts-jest',
	testEnvironment: 'node',
	testMatch: ['<rootDir>/src/**/*.jest.test.ts'],
	moduleFileExtensions: ['ts', 'js', 'json'],
	clearMocks: true
};
