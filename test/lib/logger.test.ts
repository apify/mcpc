/**
 * Unit tests for logger
 */

import {
  setVerbose,
  getVerbose,
  setLogLevel,
  debug,
  info,
  warn,
  error,
  Logger,
  createLogger,
} from '../../src/lib/logger';

describe('Verbose mode', () => {
  beforeEach(() => {
    setVerbose(false);
  });

  it('should set and get verbose mode', () => {
    expect(getVerbose()).toBe(false);
    setVerbose(true);
    expect(getVerbose()).toBe(true);
    setVerbose(false);
    expect(getVerbose()).toBe(false);
  });
});

describe('Log level', () => {
  it('should set log level', () => {
    // Test that setLogLevel doesn't throw
    expect(() => setLogLevel('debug')).not.toThrow();
    expect(() => setLogLevel('info')).not.toThrow();
    expect(() => setLogLevel('warn')).not.toThrow();
    expect(() => setLogLevel('error')).not.toThrow();
  });
});

describe('Logging functions', () => {
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    setVerbose(false);
    setLogLevel('debug');
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('should not log debug messages without verbose mode', () => {
    setVerbose(false);
    debug('test debug');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('should log debug messages in verbose mode', () => {
    setVerbose(true);
    debug('test debug');
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(consoleErrorSpy.mock.calls[0]?.[0]).toContain('test debug');
  });

  it('should log info messages to stdout', () => {
    info('test info');
    expect(consoleLogSpy).toHaveBeenCalled();
    expect(consoleLogSpy.mock.calls[0]?.[0]).toContain('test info');
  });

  it('should log warn messages to stderr', () => {
    warn('test warn');
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(consoleErrorSpy.mock.calls[0]?.[0]).toContain('test warn');
  });

  it('should log error messages to stderr', () => {
    error('test error');
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(consoleErrorSpy.mock.calls[0]?.[0]).toContain('test error');
  });

  it('should include timestamp in verbose mode', () => {
    setVerbose(true);
    info('test message');
    expect(consoleLogSpy.mock.calls[0]?.[0]).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('should not include timestamp without verbose mode', () => {
    setVerbose(false);
    info('test message');
    expect(consoleLogSpy.mock.calls[0]?.[0]).toBe('test message');
  });
});

describe('Logger class', () => {
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    setVerbose(false);
    setLogLevel('debug');
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('should create logger with context', () => {
    const logger = createLogger('TestContext');
    expect(logger).toBeInstanceOf(Logger);
  });

  it('should include context in log messages', () => {
    const logger = createLogger('TestContext');
    logger.info('test message');
    expect(consoleLogSpy).toHaveBeenCalled();
    expect(consoleLogSpy.mock.calls[0]?.[0]).toContain('[TestContext]');
    expect(consoleLogSpy.mock.calls[0]?.[0]).toContain('test message');
  });

  it('should log debug messages', () => {
    setVerbose(true);
    const logger = createLogger('TestContext');
    logger.debug('test debug');
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(consoleErrorSpy.mock.calls[0]?.[0]).toContain('[TestContext]');
  });

  it('should log info messages', () => {
    const logger = createLogger('TestContext');
    logger.info('test info');
    expect(consoleLogSpy).toHaveBeenCalled();
    expect(consoleLogSpy.mock.calls[0]?.[0]).toContain('[TestContext]');
  });

  it('should log warn messages', () => {
    const logger = createLogger('TestContext');
    logger.warn('test warn');
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(consoleErrorSpy.mock.calls[0]?.[0]).toContain('[TestContext]');
  });

  it('should log error messages', () => {
    const logger = createLogger('TestContext');
    logger.error('test error');
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(consoleErrorSpy.mock.calls[0]?.[0]).toContain('[TestContext]');
  });

  it('should log with specified level', () => {
    const logger = createLogger('TestContext');
    logger.log('info', 'test message');
    expect(consoleLogSpy).toHaveBeenCalled();
    expect(consoleLogSpy.mock.calls[0]?.[0]).toContain('[TestContext]');
  });
});
