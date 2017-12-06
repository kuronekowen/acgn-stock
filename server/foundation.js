'use strict';
import { _ } from 'meteor/underscore';
import { Meteor } from 'meteor/meteor';
import { resourceManager } from '/server/imports/threading/resourceManager';
import { dbFoundations } from '/db/dbFoundations';
import { dbLog } from '/db/dbLog';
import { dbCompanies } from '/db/dbCompanies';
import { dbCompanyArchive } from '/db/dbCompanyArchive';
import { dbDirectors } from '/db/dbDirectors';
import { dbPrice } from '/db/dbPrice';
import { debug } from '/server/imports/utils/debug';

const {foundExpireTime, foundationNeedUsers, minReleaseStock} = Meteor.settings.public;
export function checkFoundCompany() {
  debug.log('checkFoundCompany');
  const foundExpireDate = new Date(Date.now() - foundExpireTime);
  dbFoundations
    .find(
      {
        createdAt: {
          $lt: foundExpireDate
        }
      },
      {
        fields: {
          _id: 1,
          manager: 1
        },
        disableOplog: true
      }
    )
    .forEach((foundationData) => {
      const companyId = foundationData._id;
      //先鎖定資源，再重新讀取一次資料進行運算
      resourceManager.request('checkFoundCompany', ['foundation' + companyId], (release) => {
        foundationData = dbFoundations.findOne(companyId);
        if (! foundationData) {
          release();

          return false;
        }
        const invest = foundationData.invest;
        if (invest.length >= foundationNeedUsers) {
          const invest = foundationData.invest;
          const totalInvest = _.reduce(invest, (sum, investData) => {
            return sum + investData.amount;
          }, 0);
          let stockUnitPrice = 1;
          while (Math.ceil(totalInvest / stockUnitPrice / 2) > minReleaseStock) {
            stockUnitPrice *= 2;
          }
          let directors;
          let totalRelease;
          const generateDirectorStocksList = ({userId, amount}) => {
            const stocks = Math.floor(amount / stockUnitPrice);
            const remainingMoney = amount - (stockUnitPrice * stocks);

            return {userId, stocks, remainingMoney};
          };
          const sumStocks = (sum, directorData) => {
            return sum + directorData.stocks;
          };
          // TODO 解掉 do-while
          do {
            directors = _.map(invest, generateDirectorStocksList);
            totalRelease = _.reduce(directors, sumStocks, 0);
            if (totalRelease < minReleaseStock) {
              stockUnitPrice /= 2;
            }
          }
          while (totalRelease < minReleaseStock);
          const companiesBulk = dbCompanies.rawCollection().initializeUnorderedBulkOp();
          const logBulk = dbLog.rawCollection().initializeUnorderedBulkOp();
          const directorsBulk = dbDirectors.rawCollection().initializeUnorderedBulkOp();
          const usersBulk = Meteor.users.rawCollection().initializeUnorderedBulkOp();

          const basicCreatedAt = new Date();
          logBulk.insert({
            logType: '創立成功',
            userId: _.pluck(invest, 'userId'),
            companyId: companyId,
            data: { price: stockUnitPrice },
            createdAt: basicCreatedAt
          });
          const candidateList = [];
          if (foundationData.manager !== '!none') {
            candidateList.push(foundationData.manager);
          }
          companiesBulk.insert({
            _id: companyId,
            companyName: foundationData.companyName,
            manager: foundationData.manager,
            chairmanTitle: '董事長',
            tags: foundationData.tags,
            pictureSmall: foundationData.pictureSmall,
            pictureBig: foundationData.pictureBig,
            description: foundationData.description,
            illegalReason: foundationData.illegalReason,
            totalRelease: totalRelease,
            lastPrice: stockUnitPrice,
            listPrice: stockUnitPrice,
            totalValue: totalRelease * stockUnitPrice,
            profit: 0,
            candidateList: candidateList,
            voteList: [ [] ],
            salary: Meteor.settings.public.defaultCompanySalaryPerDay,
            nextSeasonSalary: Meteor.settings.public.defaultCompanySalaryPerDay,
            seasonalBonusPercent: Meteor.settings.public.defaultSeasonalBonusPercent,
            isSeal: false,
            createdAt: basicCreatedAt
          });
          dbPrice.insert({
            companyId: companyId,
            price: stockUnitPrice,
            createdAt: basicCreatedAt
          });
          let needExecuteDirectorsBulk = false;
          let needExecuteUserBulk = false;
          _.each(directors, ({userId, stocks, remainingMoney}, index) => {
            const createdAt = new Date(basicCreatedAt.getTime() + index + 1);
            if (stocks > 0) {
              logBulk.insert({
                logType: '創立得股',
                userId: [userId],
                companyId: companyId,
                data: {
                  fund: (stockUnitPrice * stocks) + remainingMoney,
                  stocks
                },
                createdAt: createdAt
              });
              needExecuteDirectorsBulk = true;
              directorsBulk.insert({companyId, userId, stocks, createdAt});
            }
            if (remainingMoney > 0) {
              logBulk.insert({
                logType: '創立退款',
                userId: [userId],
                companyId: companyId,
                data: {
                  companyName: foundationData.companyName, // TODO lagecy field
                  refund: remainingMoney
                },
                createdAt: createdAt
              });
              needExecuteUserBulk = true;
              usersBulk.find({_id: userId}).updateOne({
                $inc: {
                  'profile.money': remainingMoney
                }
              });
            }
          });
          companiesBulk.execute = Meteor.wrapAsync(companiesBulk.execute);
          companiesBulk.execute();
          logBulk.execute = Meteor.wrapAsync(logBulk.execute);
          logBulk.execute();
          if (needExecuteDirectorsBulk) {
            directorsBulk.execute = Meteor.wrapAsync(directorsBulk.execute);
            directorsBulk.execute();
          }
          if (needExecuteUserBulk) {
            usersBulk.execute = Meteor.wrapAsync(usersBulk.execute);
            usersBulk.execute();
          }
          dbFoundations.remove(companyId);
          dbCompanyArchive.update(companyId, {
            $set: {
              status: 'market'
            }
          });
        }
        else {
          const logBulk = dbLog.rawCollection().initializeUnorderedBulkOp();
          const usersBulk = Meteor.users.rawCollection().initializeUnorderedBulkOp();

          const createdAt = new Date();
          logBulk.insert({
            logType: '創立失敗',
            userId: _.union([foundationData.manager], _.pluck(invest, 'userId')),
            data: {
              companyName: foundationData.companyName
            },
            createdAt: createdAt
          });
          _.each(foundationData.invest, ({userId, amount}, index) => {
            if (userId === foundationData.manager) {
              amount -= Meteor.settings.public.founderEarnestMoney;
            }
            logBulk.insert({
              logType: '創立退款',
              userId: [userId],
              data: {
                companyName: foundationData.companyName,
                refund: amount
              },
              createdAt: new Date(createdAt.getTime() + index + 1)
            });
            usersBulk.find({_id: userId}).updateOne({
              $inc: {
                'profile.money': amount
              }
            });
          });
          dbFoundations.remove(companyId);
          dbCompanyArchive.remove(companyId);
          logBulk
            .find({companyId})
            .update({
              $unset: {
                companyId: ''
              }
            });
          logBulk.execute = Meteor.wrapAsync(logBulk.execute);
          logBulk.execute();
          if (foundationData.invest.length > 0) {
            usersBulk.execute = Meteor.wrapAsync(usersBulk.execute);
            usersBulk.execute();
          }
        }
        release();
      });
    });
}
