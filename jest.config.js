module.exports = {
    testEnvironment: 'jsdom',
    clearMocks: true,
    collectCoverage: true,
    collectCoverageFrom: ['src/**/*.{ts,js}'],
    setupFilesAfterEnv: ['<rootDir>/config/jest/afterEnv.js'],
};
