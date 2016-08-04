// Edit from https://github.com/zalmoxisus/remote-redux-devtools/blob/master/src/devTools.js

import { stringify, parse } from 'jsan';
import instrument from 'redux-devtools-instrument';
import { evalAction, getActionsArray } from 'remotedev-utils';

function configureStore(next, subscriber, options) {
  return instrument(subscriber, options)(next);
}

const monitorActions = [ // To be skipped for relaying actions
  '@@redux/INIT', 'TOGGLE_ACTION', 'SWEEP', 'IMPORT_STATE', 'SET_ACTIONS_ACTIVE',
];

let store = {};
let lastAction;
let filters;
let isExcess;
let started;
let actionCreators;

function init(options) {
  if (options.filters) {
    filters = options.filters;
  }
  if (options.actionCreators) {
    actionCreators = () => getActionsArray(options.actionCreators);
  }
}

function isFiltered(action) {
  if (!action || !action.action || !action.action.type) return false;
  return (
    filters.whitelist && !action.action.type.match(filters.whitelist.join('|')) ||
    filters.blacklist && action.action.type.match(filters.blacklist.join('|'))
  );
}

function filterStagedActions(state) {
  if (!filters) return state;

  const filteredStagedActionIds = [];
  const filteredComputedStates = [];

  state.stagedActionIds.forEach((id, idx) => {
    if (!isFiltered(state.actionsById[id])) {
      filteredStagedActionIds.push(id);
      filteredComputedStates.push(state.computedStates[idx]);
    }
  });

  return {
    ...state,
    stagedActionIds: filteredStagedActionIds,
    computedStates: filteredComputedStates,
  };
}

function getLiftedState() {
  return filterStagedActions(store.liftedStore.getState());
}

function relay(type, state, action, nextActionId) {
  if (filters && isFiltered(action)) return;
  const message = {
    type,
    id: 'redux-native-devtools',
  };
  if (state) message.payload = type === 'ERROR' ? state : stringify(state);
  if (type === 'ACTION') {
    message.action = stringify(action);
    message.isExcess = isExcess;
    message.nextActionId = nextActionId;
  } else if (action) {
    message.action = stringify(action);
  }
  postMessage({ __IS_REDUX_NATIVE_MESSAGE__: true, content: message });
}

function dispatchRemotely(action) {
  try {
    const result = evalAction(action, actionCreators);
    store.dispatch(result);
  } catch (e) {
    relay('ERROR', e.message);
  }
}

function handleMessages(message) {
  if (message.type === 'IMPORT') {
    store.liftedStore.dispatch({
      type: 'IMPORT_STATE',
      nextLiftedState: parse(message.state),
    });
  }
  if (message.type === 'UPDATE' || message.type === 'IMPORT') {
    relay('STATE', getLiftedState());
  }
  if (message.type === 'ACTION') {
    dispatchRemotely(message.action);
  } else if (message.type === 'DISPATCH') {
    store.liftedStore.dispatch(message.action);
  }
}

function start() {
  if (started) return;
  started = true;

  self.addEventListener('message', message => {
    const { method, content } = message.data;
    if (method === 'emitReduxMessage') {
      handleMessages(content);
    }
  });
  if (typeof actionCreators === 'function') actionCreators = actionCreators();
  relay('STATE', getLiftedState(), actionCreators);

  // Because the worker message not have notify the remote JS runtime
  // we need to regularly update JS runtime
  setInterval(function(){}, 222); // eslint-disable-line
}

function monitorReducer(state = {}, action) {
  lastAction = action.type;
  return state;
}

function handleChange(state, liftedState, maxAge) {
  const nextActionId = liftedState.nextActionId;
  const liftedAction = liftedState.actionsById[nextActionId - 1];
  const action = liftedAction.action;

  if (action.type === '@@INIT') {
    relay('INIT', state, { timestamp: Date.now() });
  } else if (monitorActions.indexOf(lastAction) === -1) {
    if (lastAction === 'JUMP_TO_STATE') return;
    relay('ACTION', state, liftedAction, nextActionId);
    if (!isExcess && maxAge) isExcess = liftedState.stagedActionIds.length >= maxAge;
  } else {
    relay('STATE', filterStagedActions(liftedState));
  }
}

export default (options = {}) => {
  init(options);
  const maxAge = options.maxAge || 30;
  return next => (reducer, initialState) => {
    store = configureStore(
      next, monitorReducer, { maxAge }
    )(reducer, initialState);

    start();
    store.subscribe(() => {
      handleChange(store.getState(), store.liftedStore.getState(), maxAge);
    });
    return store;
  };
};
