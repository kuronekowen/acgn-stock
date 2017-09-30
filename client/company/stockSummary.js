'use strict';
import { $ } from 'meteor/jquery';
import { Meteor } from 'meteor/meteor';
import { Template } from 'meteor/templating';
import { ReactiveVar } from 'meteor/reactive-var';
import { FlowRouter } from 'meteor/kadira:flow-router';
import { dbCompanies } from '../../db/dbCompanies';
import { dbDirectors } from '../../db/dbDirectors';
import { dbOrders } from '../../db/dbOrders';
import { inheritedShowLoadingOnSubscribing } from '../layout/loading';
import { createBuyOrder, createSellOrder, retrieveOrder, changeChairmanTitle, toggleFavorite } from '../utils/methods';
import { isUserId, isChairman } from '../utils/helpers';
import { shouldStopSubscribe } from '../utils/idle';
import { rCompanyListViewMode } from '../utils/styles';

inheritedShowLoadingOnSubscribing(Template.stockSummary);
const rKeyword = new ReactiveVar('');
const rFilterBy = new ReactiveVar('none');
const rSortBy = new ReactiveVar('lastPrice');
export const rStockOffset = new ReactiveVar(0);
Template.stockSummary.onCreated(function() {
  this.autorun(() => {
    if (shouldStopSubscribe()) {
      return false;
    }
    const keyword = rKeyword.get();
    const isOnlyShowMine = (rFilterBy.get() === 'mine');
    const isOnlyFavorite = (rFilterBy.get() === 'favorite');
    const sort = rSortBy.get();
    const offset = rStockOffset.get();
    this.subscribe('stockSummary', keyword, isOnlyShowMine, isOnlyFavorite, sort, offset);
  });
  this.autorun(() => {
    if (shouldStopSubscribe()) {
      return false;
    }
    if (Meteor.user()) {
      this.subscribe('queryOwnStocks');
      this.subscribe('queryMyOrder');
    }
  });
});
Template.stockSummary.helpers({
  viewModeIsCard() {
    return rCompanyListViewMode.get() === 'card';
  },
  companyList() {
    return dbCompanies.find({}, {
      sort: {
        [rSortBy.get()]: -1
      },
      limit: 12
    });
  },
  paginationData() {
    return {
      useVariableForTotalCount: 'totalCountOfStockSummary',
      dataNumberPerPage: 12,
      offset: rStockOffset,
      useHrefRoute: true
    };
  }
});

Template.stockFilterForm.onRendered(function() {
  this.$keyword = this.$('[name="keyword"]');
});
Template.stockFilterForm.helpers({
  viewModeBtnClass() {
    if (rCompanyListViewMode.get() === 'card') {
      return 'fa-th';
    }

    return 'fa-th-list';
  },
  filterModeText() {
    if (! Meteor.user()) {
      return '全部顯示';
    }

    const filterBy = rFilterBy.get();
    if (filterBy === 'mine') {
      return '只顯示持有';
    }
    if (filterBy === 'favorite') {
      return '只顯示最愛';
    }

    return '全部顯示';
  },
  sortByBtnClass(sortByField) {
    if (sortByField === rSortBy.get()) {
      return 'btn btn-secondary active';
    }
    else {
      return 'btn btn-secondary';
    }
  },
  keyword() {
    return rKeyword.get();
  }
});
Template.stockFilterForm.events({
  'click [data-action="toggleViewMode"]'(event) {
    event.preventDefault();
    let mode = 'card';
    if (rCompanyListViewMode.get() === mode) {
      mode = 'form';
    }
    rCompanyListViewMode.set(mode);
  },
  'click [data-action="sortBy"]'(event) {
    const newValue = $(event.currentTarget).val();
    FlowRouter.go('stockSummary', {
      page: 1
    });
    rSortBy.set(newValue);
  },
  'click [data-action="filterBy"]'(event) {
    const newValue = $(event.currentTarget).attr('value');
    const dropdown = $(event.currentTarget)
      .parent()
      .parent();
    dropdown.toggleClass('show');
    FlowRouter.go('stockSummary', {
      page: 1
    });
    rFilterBy.set(newValue);
  },
  'click [data-toggle="dropdown"]'(event) {
    $(event.currentTarget)
      .parent()
      .toggleClass('show');
  },
  'submit'(event, templateInstance) {
    event.preventDefault();
    FlowRouter.go('stockSummary', {
      page: 1
    });
    rKeyword.set(templateInstance.$keyword.val());
  }
});

const companySummaryHelpers = {
  displayTagList(tagList) {
    return tagList.join('、');
  },
  cardDisplayClass(companyData) {
    if (! Meteor.user()) {
      return 'company-card-default';
    }
    if (isChairman(companyData._id)) {
      return 'company-card-chairman';
    }
    if (isUserId(companyData.manager)) {
      return 'company-card-manager';
    }
    const percentage = companySummaryHelpers.getStockPercentage(companyData._id, companyData.totalRelease);
    if (percentage > 0) {
      return 'company-card-holder';
    }

    return 'company-card-default';
  },
  priceDisplayClass(lastPrice, listPrice) {
    if (lastPrice > listPrice) {
      return 'text-danger';
    }
    else if (listPrice > lastPrice) {
      return 'text-success';
    }
  },
  getManageHref(companyId) {
    return FlowRouter.path('manageCompany', {companyId});
  },
  getStockAmount(companyId) {
    const userId = Meteor.user()._id;
    const ownStockData = dbDirectors.findOne({companyId, userId});

    return ownStockData ? ownStockData.stocks : 0;
  },
  getStockPercentage(companyId, totalRelease) {
    const userId = Meteor.user()._id;
    const ownStockData = dbDirectors.findOne({companyId, userId});

    if (ownStockData) {
      return Math.round(ownStockData.stocks / totalRelease * 10000) / 100;
    }

    return 0;
  },
  existOwnOrder(companyId) {
    const userId = Meteor.user()._id;

    return ! ! dbOrders.findOne({companyId, userId});
  },
  ownOrderList(companyId) {
    const userId = Meteor.user()._id;

    return dbOrders.find({companyId, userId});
  }
};
const companySummaryEvents = {
  'click [data-action="changeChairmanTitle"]'(event, templateInstance) {
    const companyData = templateInstance.data;
    changeChairmanTitle(companyData);
  },
  'click [data-action="createBuyOrder"]'(event, templateInstance) {
    event.preventDefault();
    createBuyOrder(Meteor.user(), templateInstance.data);
  },
  'click [data-action="createSellOrder"]'(event, templateInstance) {
    event.preventDefault();
    createSellOrder(Meteor.user(), templateInstance.data);
  },
  'click [data-toggle-favorite]'(event) {
    event.preventDefault();
    const companyId = $(event.currentTarget).attr('data-toggle-favorite');
    toggleFavorite(companyId);
  },
  'click [data-expand-order]'(event, templateInstance) {
    event.preventDefault();
    const panel = templateInstance.$('.order-panel');
    const maxHeight = panel.css('max-height');
    if (maxHeight === '0px') {
      panel.css('max-height', panel.prop('scrollHeight'));
    }
    else {
      panel.css('max-height', 0);
    }
  },
  'click [data-cancel-order]'(event) {
    event.preventDefault();
    const orderId = $(event.currentTarget).attr('data-cancel-order');
    const orderData = dbOrders.findOne(orderId);
    retrieveOrder(orderData);
  }
};
Template.companySummaryList.helpers(companySummaryHelpers);
Template.companySummaryList.events(companySummaryEvents);
Template.companySummaryCard.helpers(companySummaryHelpers);
Template.companySummaryCard.events(companySummaryEvents);
