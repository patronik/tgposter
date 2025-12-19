module.exports.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports.getRandomNumber = (min, max) => {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
