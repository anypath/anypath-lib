'use strict';

var _ = require('lodash');
var assert = require('assert');
var UInt160 = require('./uint160').UInt160;
var Amount = require('./amount').Amount;
var Utils = require('./orderbookutils');

function assertValidNumber(number, message) {
  assert(!_.isNull(number) && !isNaN(number), message);
}

function assertValidLegOneOffer(legOneOffer, message) {
  assert(legOneOffer);
  assert.strictEqual(typeof legOneOffer, 'object', message);
  assert.strictEqual(typeof legOneOffer.TakerPays, 'object', message);
  assertValidNumber(legOneOffer.TakerGets, message);
}

function AutobridgeCalculator(currencyGets, currencyPays,
  legOneOffers, legTwoOffers) {
  this._currencyGets = currencyGets;
  this._currencyPays = currencyPays;
  this.legOneOffers = _.cloneDeep(legOneOffers);
  this.legTwoOffers = _.cloneDeep(legTwoOffers);

  this._ownerFundsLeftover = {};
}

/**
 * Calculates an ordered array of autobridged offers by quality
 *
 * @return {Array}
 */

AutobridgeCalculator.prototype.calculate = function() {
  var legOnePointer = 0;
  var legTwoPointer = 0;

  var offersAutobridged = [];

  this.clearOwnerFundsLeftover();

  while (this.legOneOffers[legOnePointer] && this.legTwoOffers[legTwoPointer]) {
    var legOneOffer = this.legOneOffers[legOnePointer];
    var legTwoOffer = this.legTwoOffers[legTwoPointer];
    var leftoverFunds = this.getLeftoverOwnerFunds(legOneOffer.Account);
    var autobridgedOffer;

    if (legOneOffer.Account === legTwoOffer.Account) {
      this.unclampLegOneOwnerFunds(legOneOffer);
    } else if (!legOneOffer.is_fully_funded && !leftoverFunds.is_zero()) {
      this.adjustLegOneFundedAmount(legOneOffer);
    }

    var legOneTakerGetsFunded = Utils.getOfferTakerGetsFunded(legOneOffer);
    var legTwoTakerPaysFunded = Utils.getOfferTakerPaysFunded(legTwoOffer);

    if (legOneTakerGetsFunded.is_zero()) {
      legOnePointer++;

      continue;
    }

    if (legTwoTakerPaysFunded.is_zero()) {
      legTwoPointer++;

      continue;
    }

    if (legOneTakerGetsFunded.compareTo(legTwoTakerPaysFunded) > 0) {
      autobridgedOffer = this.getAutobridgedOfferWithClampedLegOne(
        legOneOffer,
        legTwoOffer
      );

      legTwoPointer++;
    } else if (legTwoTakerPaysFunded.compareTo(legOneTakerGetsFunded) > 0) {
      autobridgedOffer = this.getAutobridgedOfferWithClampedLegTwo(
        legOneOffer,
        legTwoOffer
      );

      legOnePointer++;
    } else {
      autobridgedOffer = this.getAutobridgedOfferWithoutClamps(
        legOneOffer,
        legTwoOffer
      );

      legOnePointer++;
      legTwoPointer++;
    }

    offersAutobridged.push(autobridgedOffer);
  }

  return offersAutobridged;
};

/**
 * In this case, the output from leg one is greater than the input to leg two.
 * Therefore, we must effectively clamp leg one output to leg two input.
 *
 * @param {Object} legOneOffer
 * @param {Object} legTwoOffer
 *
 * @return {Object}
 */

AutobridgeCalculator.prototype.getAutobridgedOfferWithClampedLegOne =
function(legOneOffer, legTwoOffer) {
  var legOneTakerGetsFunded = Utils.getOfferTakerGetsFunded(legOneOffer);
  var legTwoTakerPaysFunded = Utils.getOfferTakerPaysFunded(legTwoOffer);
  var legOneQuality = Utils.getOfferQuality(legOneOffer, this._currencyGets);

  var autobridgedTakerGets = Utils.getOfferTakerGetsFunded(legTwoOffer);
  var autobridgedTakerPays = legTwoTakerPaysFunded.multiply(legOneQuality);

  if (legOneOffer.Account === legTwoOffer.Account) {
    var legOneTakerGets = Utils.getOfferTakerGets(legOneOffer);
    var updatedTakerGets = legOneTakerGets.subtract(legTwoTakerPaysFunded);

    this.setLegOneTakerGets(legOneOffer, updatedTakerGets);

    this.clampLegOneOwnerFunds(legOneOffer);
  } else {
    // Update funded amount since leg one offer was not completely consumed
    var updatedTakerGetsFunded = legOneTakerGetsFunded
      .subtract(legTwoTakerPaysFunded);

    this.setLegOneTakerGetsFunded(legOneOffer, updatedTakerGetsFunded);
  }

  return this.formatAutobridgedOffer(
    autobridgedTakerGets,
    autobridgedTakerPays
  );
};

/**
 * In this case, the input from leg two is greater than the output to leg one.
 * Therefore, we must effectively clamp leg two input to leg one output.
 *
 * @param {Object} legOneOffer
 * @param {Object} legTwoOffer
 *
 * @return {Object}
 */

AutobridgeCalculator.prototype.getAutobridgedOfferWithClampedLegTwo =
function(legOneOffer, legTwoOffer) {
  var legOneTakerGetsFunded = Utils.getOfferTakerGetsFunded(legOneOffer);
  var legTwoTakerPaysFunded = Utils.getOfferTakerPaysFunded(legTwoOffer);
  var legTwoQuality = Utils.getOfferQuality(legTwoOffer, this._currencyGets);

  var autobridgedTakerGets = legOneTakerGetsFunded.divide(legTwoQuality);
  var autobridgedTakerPays = Utils.getOfferTakerPaysFunded(legOneOffer);

  // Update funded amount since leg two offer was not completely consumed
  legTwoOffer.taker_gets_funded = Utils.getOfferTakerGetsFunded(legTwoOffer)
    .subtract(autobridgedTakerGets)
    .to_text();
  legTwoOffer.taker_pays_funded = legTwoTakerPaysFunded
    .subtract(legOneTakerGetsFunded)
    .to_text();

  return this.formatAutobridgedOffer(
    autobridgedTakerGets,
    autobridgedTakerPays
  );
};

/**
 * In this case, the output from leg one and the input to leg two are the same.
 * We do not need to clamp either.
 * @param {Object} legOneOffer
 * @param {Object} legTwoOffer
 *
 * @return {Object}
 */

AutobridgeCalculator.prototype.getAutobridgedOfferWithoutClamps =
function(legOneOffer, legTwoOffer) {
  var autobridgedTakerGets = Utils.getOfferTakerGetsFunded(legTwoOffer);
  var autobridgedTakerPays = Utils.getOfferTakerPaysFunded(legOneOffer);

  return this.formatAutobridgedOffer(
    autobridgedTakerGets,
    autobridgedTakerPays
  );
};

/**
 * Clear owner funds leftovers
 */

AutobridgeCalculator.prototype.clearOwnerFundsLeftover = function() {
  this._ownerFundsLeftover = {};
};

/**
 * Reset owner funds leftovers for an account to 0
 *
 * @param {String} account
 *
 * @return {Amount}
 */

AutobridgeCalculator.prototype.resetOwnerFundsLeftover = function(account) {
  assert(UInt160.is_valid(account), 'Account is invalid');

  this._ownerFundsLeftover[account] = Utils.normalizeAmount('0');

  return this._ownerFundsLeftover[account];
};

/**
 * Retrieve leftover funds found after clamping leg one by account
 *
 * @param {String} account
 *
 * @return {Amount}
 */

AutobridgeCalculator.prototype.getLeftoverOwnerFunds = function(account) {
  assert(UInt160.is_valid(account), 'Account is invalid');

  var amount = this._ownerFundsLeftover[account];

  if (!amount) {
    amount = Utils.normalizeAmount('0');
  }

  return amount;
};

/**
 * Add funds to account's leftover funds
 *
 * @param {String} account
 * @param {Amount} amount
 *
 * @return {Amount}
 */

AutobridgeCalculator.prototype.addLeftoverOwnerFunds =
function(account, amount) {
  assert(UInt160.is_valid(account), 'Account is invalid');
  assert(amount instanceof Amount, 'Amount is invalid');

  this._ownerFundsLeftover[account] = this.getLeftoverOwnerFunds(account)
    .add(amount);

  return this._ownerFundsLeftover[account];
};

/**
 * Set account's leftover funds
 *
 * @param {String} account
 * @param {Amount} amount
 */

AutobridgeCalculator.prototype.setLeftoverOwnerFunds =
function(account, amount) {
  assert(UInt160.is_valid(account), 'Account is invalid');
  assert(amount instanceof Amount, 'Amount is invalid');

  this._ownerFundsLeftover[account] = amount;
};

/**
 * Format an autobridged offer and compute synthetic values (e.g. quality)
 *
 * @param {Amount} takerGets
 * @param {Amount} takerPays
 *
 * @return {Object}
 */

AutobridgeCalculator.prototype.formatAutobridgedOffer =
function(takerGets, takerPays) {
  assert(takerGets instanceof Amount, 'Autobridged taker gets is invalid');
  assert(takerPays instanceof Amount, 'Autobridged taker pays is invalid');

  var autobridgedOffer = {};
  var quality = takerPays.divide(takerGets);

  autobridgedOffer.TakerGets = {
    value: takerGets.to_text(),
    currency: this._currencyGets.to_hex(),
    issuer: this._issuerGets
  };

  autobridgedOffer.TakerPays = {
    value: takerPays.to_text(),
    currency: this._currencyPays.to_hex(),
    issuer: this._issuerPays
  };

  autobridgedOffer.quality = quality.to_text();

  autobridgedOffer.taker_gets_funded = autobridgedOffer.TakerGets.value;
  autobridgedOffer.taker_pays_funded = autobridgedOffer.TakerPays.value;

  autobridgedOffer.autobridged = true;

  autobridgedOffer.BookDirectory = Utils.convertOfferQualityToHex(quality);

  return autobridgedOffer;
};

/**
 * Remove funds clamp on leg one offer. This is necessary when the two offers
 * are owned by the same account. In this case, it doesn't matter if offer one
 * is not fully funded. Leg one out goes to leg two in and since its the same
 * account, an infinite amount can flow.
 *
 * @param {Object} legOneOffer - IOU:XRP offer
 */

AutobridgeCalculator.prototype.unclampLegOneOwnerFunds = function(legOneOffer) {
  assertValidLegOneOffer(legOneOffer, 'Leg one offer is invalid');

  legOneOffer.initTakerGetsFunded = Utils.getOfferTakerGetsFunded(legOneOffer);

  this.setLegOneTakerGetsFunded(
    legOneOffer,
    Utils.getOfferTakerGets(legOneOffer)
  );
};

/**
 * Apply clamp back on leg one offer after a round of autobridge calculation
 * completes. We must reapply clamps that have been removed because we cannot
 * guarantee that the next offer from leg two will also be from the same
 * account.
 *
 * When we reapply, it could happen that the amount of TakerGets left after
 * the autobridge calculation is less than the original funded amount. In this
 * case, we have extra funds we can use towards unfunded offers with worse
 * quality by the same owner.
 *
 * @param {Object} legOneOffer - IOU:XRP offer
 */

AutobridgeCalculator.prototype.clampLegOneOwnerFunds = function(legOneOffer) {
  assertValidLegOneOffer(legOneOffer, 'Leg one offer is invalid');

  var takerGets = Utils.getOfferTakerGets(legOneOffer);

  if (takerGets.compareTo(legOneOffer.initTakerGetsFunded) > 0) {
    // After clamping, TakerGets is still greater than initial funded amount
    this.setLegOneTakerGetsFunded(legOneOffer, legOneOffer.initTakerGetsFunded);
  } else {
    var updatedLeftover = legOneOffer.initTakerGetsFunded.subtract(takerGets);

    this.setLegOneTakerGetsFunded(legOneOffer, takerGets);
    this.addLeftoverOwnerFunds(legOneOffer.Account, updatedLeftover);
  }
};

/**
 * Increase leg one offer funded amount with extra funds found after applying
 * clamp.
 *
 * @param {Object} legOneOffer - IOU:XRP offer
 */

AutobridgeCalculator.prototype.adjustLegOneFundedAmount =
function(legOneOffer) {
  assertValidLegOneOffer(legOneOffer, 'Leg one offer is invalid');
  assert(!legOneOffer.is_fully_funded, 'Leg one offer cannot be fully funded');

  var fundedSum = Utils.getOfferTakerGetsFunded(legOneOffer)
    .add(this.getLeftoverOwnerFunds(legOneOffer.Account));

  if (fundedSum.compareTo(Utils.getOfferTakerGets(legOneOffer)) >= 0) {
    // There are enough extra funds to fully fund the offer
    var legOneTakerGets = Utils.getOfferTakerGets(legOneOffer);
    var updatedLeftover = fundedSum.subtract(legOneTakerGets);

    this.setLegOneTakerGetsFunded(legOneOffer, legOneTakerGets);
    this.setLeftoverOwnerFunds(legOneOffer.Account, updatedLeftover);
  } else {
    // There are not enough extra funds to fully fund the offer
    this.setLegOneTakerGetsFunded(legOneOffer, fundedSum);
    this.resetOwnerFundsLeftover(legOneOffer.Account);
  }
};

/**
 * Set taker gets funded amount for a IOU:XRP offer. Also calculates taker
 * pays funded using offer quality and updates is_fully_funded flag
 *
 * @param {Object} legOneOffer - IOU:XRP offer
 * @param {Amount} takerGetsFunded
 */

AutobridgeCalculator.prototype.setLegOneTakerGetsFunded =
function setLegOneTakerGetsFunded(legOneOffer, takerGetsFunded) {
  assertValidLegOneOffer(legOneOffer, 'Leg one offer is invalid');
  assert(takerGetsFunded instanceof Amount, 'Taker gets funded is invalid');

  legOneOffer.taker_gets_funded = takerGetsFunded.to_text();
  legOneOffer.taker_pays_funded = takerGetsFunded
    .multiply(Utils.getOfferQuality(legOneOffer, this._currencyGets))
    .to_text();

  if (legOneOffer.taker_gets_funded === legOneOffer.TakerGets.value) {
    legOneOffer.is_fully_funded = true;
  }
};

/**
 * Set taker gets amount for a IOU:XRP offer. Also calculates taker pays
 * using offer quality
 *
 * @param {Object} legOneOffer - IOU:XRP offer
 * @param {Amount} takerGets
 */

AutobridgeCalculator.prototype.setLegOneTakerGets =
function(legOneOffer, takerGets) {
  assertValidLegOneOffer(legOneOffer, 'Leg one offer is invalid');
  assert(takerGets instanceof Amount, 'Taker gets funded is invalid');

  var legOneQuality = Utils.getOfferQuality(legOneOffer, this._currencyGets);

  legOneOffer.TakerGets = takerGets.to_text();
  legOneOffer.TakerPays = takerGets.multiply(legOneQuality);
};

module.exports = AutobridgeCalculator;
