Object.assign(global, {
  chrome: {
    runtime: {
      onMessage: {
        addListener: jest.fn(),
      },
      onInstalled: {
        addListener: jest.fn(),
      },
      onStartup: {
        addListener: jest.fn(),
      },
      getURL: jest.fn(),
    },
    alarms: {
      onAlarm: {
        addListener: jest.fn(),
      },
      create: jest.fn(),
      clear: jest.fn(),
    },
    storage: {
      local: {
        get: jest.fn(),
        set: jest.fn(),
      },
    },
    tabs: {
      onRemoved: {
        addListener: jest.fn(),
      },
      onUpdated: {
        addListener: jest.fn(),
      },
      create: jest.fn(),
      update: jest.fn(),
      query: jest.fn(),
      sendMessage: jest.fn(),
    },
    scripting: {
      executeScript: jest.fn(),
    },
    commands: {
      onCommand: {
        addListener: jest.fn(),
      }
    }
  },
});
