var gulp = require('gulp')
var babel = require('gulp-babel')
var watch = require('gulp-watch')

gulp.task('default', function () {
  return gulp.src('src/**/*.js')
    .pipe(watch('src/**/*.js'))
    .pipe(babel({
      plugins: ['transform-runtime'],
      presets: ['latest']
    }))
    .pipe(gulp.dest('build'))
})

gulp.task('buildonly', function () {
  return gulp.src('src/**/*.js')
    .pipe(babel({
      plugins: ['transform-runtime'],
      presets: ['latest']
    }))
    .pipe(gulp.dest('build'))
})
